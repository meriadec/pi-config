import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";
import { WorkDataError } from "../shared/domain.ts";
import type { MainAgentManager } from "./main-agent.ts";
import type { TopicService } from "./topic-service.ts";
import {
  MAX_PARSE_ERRORS,
  NdjsonDecoder,
  ProtocolError,
  WORK_PROTOCOL_VERSION,
  encodeMessage,
  failure,
  parseRequest,
  type DaemonSnapshot,
  type ServerMessage,
  type WorkEvent,
  type WorkResponse,
} from "./protocol.ts";

const MAX_CLIENT_BUFFER_BYTES = 128 * 1024;

export interface WorkDaemonOptions {
  socketPath: string;
  runtimeDirectory?: string;
  uid?: number;
  now?: () => Date;
  topicService?: TopicService;
  mainAgent?: MainAgentManager;
}

interface ClientState {
  socket: Socket;
  decoder: NdjsonDecoder;
  parseErrors: number;
  subscribed: boolean;
  connectionId: string;
}

export class WorkDaemon {
  private readonly clients = new Set<ClientState>();
  private server: Server | undefined;
  private readonly startedAt: string;
  private stopping = false;
  private ownsSocket = false;
  private readonly options: WorkDaemonOptions;
  private unsubscribeTopics: (() => void) | undefined;
  private unsubscribeAgents: (() => void) | undefined;
  private nextConnectionId = 1;
  private revision = 0;

  constructor(options: WorkDaemonOptions) {
    this.options = options;
    this.startedAt = (options.now ?? (() => new Date()))().toISOString();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  snapshot(): DaemonSnapshot {
    const topics = this.options.topicService?.snapshot() ?? {
      topics: [],
      diagnostics: [],
      operations: [],
    };
    return {
      revision: this.revision,
      ...topics,
      mainAgents: this.options.mainAgent?.snapshot() ?? [],
      daemon: {
        protocolVersion: WORK_PROTOCOL_VERSION,
        pid: process.pid,
        startedAt: this.startedAt,
      },
    };
  }

  async start(): Promise<void> {
    if (this.server !== undefined) throw new Error("Work daemon is already started.");
    validateSocketPath(this.options.socketPath, this.options.runtimeDirectory);
    this.unsubscribeTopics = this.options.topicService?.subscribe((event) => this.publish(event));
    this.unsubscribeAgents = this.options.mainAgent?.subscribe((event) => this.publish(event));
    try {
      await this.options.topicService?.start();
      await this.options.mainAgent?.start();
    } catch (error) {
      this.cleanupSources();
      throw error;
    }
    try {
      await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
      await removeOwnedStaleSocket(this.options.socketPath, this.options.uid ?? process.getuid?.());
    } catch (error) {
      this.cleanupSources();
      throw error;
    }

    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    server.on("error", () => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.ownsSocket = true;
      await chmod(this.options.socketPath, 0o600);
    } catch (error) {
      this.server = undefined;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (this.ownsSocket) {
        this.ownsSocket = false;
        await unlink(this.options.socketPath).catch(() => undefined);
      }
      this.cleanupSources();
      throw error;
    }
  }

  publish(event: WorkEvent): void {
    this.revision += 1;
    const message = encodeMessage({
      version: WORK_PROTOCOL_VERSION,
      kind: "event",
      revision: this.revision,
      event,
    });
    for (const client of this.clients) {
      if (client.subscribed) this.write(client, message);
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.publish({ type: "daemon-stopping" });
    this.cleanupSources();
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (this.ownsSocket) {
      this.ownsSocket = false;
      await unlink(this.options.socketPath).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  private cleanupSources(): void {
    this.unsubscribeTopics?.();
    this.unsubscribeTopics = undefined;
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = undefined;
    this.options.topicService?.stop();
    this.options.mainAgent?.stop();
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true);
    const client: ClientState = {
      socket,
      decoder: new NdjsonDecoder(),
      parseErrors: 0,
      subscribed: false,
      connectionId: String(this.nextConnectionId++),
    };
    this.clients.add(client);
    const remove = (): void => {
      this.clients.delete(client);
      this.options.mainAgent?.disconnected(client.connectionId);
    };
    socket.on("close", remove);
    socket.on("error", remove);
    socket.on("data", (chunk) => {
      void this.receive(client, chunk);
    });
  }

  private receive(client: ClientState, chunk: Buffer): void {
    for (const frame of client.decoder.feed(chunk)) {
      if (!frame.ok) {
        this.protocolFailure(client, null, frame.code, frame.message);
      } else {
        void this.handleFrame(client, frame.text);
      }
    }
  }

  private async handleFrame(client: ClientState, text: string): Promise<void> {
    try {
      const request = parseRequest(text);
      let result: unknown;
      switch (request.action) {
        case "ping":
          result = { protocolVersion: WORK_PROTOCOL_VERSION, pid: process.pid };
          break;
        case "snapshot":
          result = this.snapshot();
          break;
        case "refresh":
          await this.requireTopicService().refreshPullRequests();
          result = { refreshed: true };
          break;
        case "subscribe":
          // Install the subscription and take its baseline in one synchronous turn. Events
          // written after this response always have a later revision than the snapshot.
          client.subscribed = true;
          result = { subscribed: true, snapshot: this.snapshot() };
          break;
        case "topic.create":
          result = await this.requireTopicService().create(
            request.clientId,
            request.id,
            request.input,
          );
          break;
        case "topic.retry":
          result = await this.requireTopicService().retry(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "topic.rename":
          result = await this.requireTopicService().rename(
            request.clientId,
            request.id,
            request.topicId,
            request.name,
          );
          break;
        case "topic.set-focus":
          result = await this.requireTopicService().setFocus(
            request.clientId,
            request.id,
            request.topicId,
            request.focused,
          );
          break;
        case "topic.delete":
          result = await this.requireTopicService().delete(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "workspace.access":
          result = await this.requireTopicService().accessWorkspace(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "terminal.open":
          result = await this.requireTopicService().openTerminal(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "agent.open":
          result = await this.requireTopicService().openMainAgent(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "agent.reset":
          result = await this.requireTopicService().resetMainAgent(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "pull-request.open":
          result = await this.requireTopicService().openPullRequest(
            request.clientId,
            request.id,
            request.topicId,
          );
          break;
        case "agent.register":
          result = await this.requireMainAgent().register({
            connectionId: client.connectionId,
            topicId: request.topicId,
            sessionId: request.sessionId,
            sessionFile: request.sessionFile,
            token: request.token,
            ...(request.affiliationToken === undefined
              ? {}
              : { affiliationToken: request.affiliationToken }),
          });
          await this.options.topicService?.refreshTopic(request.topicId);
          break;
        case "agent.heartbeat":
          result = this.requireMainAgent().heartbeat(client.connectionId);
          break;
        case "agent.thinking":
          result = this.requireMainAgent().transition(client.connectionId, "thinking");
          break;
        case "agent.tracking-pr":
          result = this.requireMainAgent().transition(client.connectionId, "tracking-pr");
          break;
        case "agent.waiting":
          result = this.requireMainAgent().transition(client.connectionId, "waiting-for-human");
          break;
        case "agent.stopped":
          result = this.requireMainAgent().transition(client.connectionId, "stopped");
          break;
        case "action.confirm":
          result = await this.requireTopicService().confirm(
            request.clientId,
            request.id,
            request.token,
          );
          break;
        case "action.reject":
          result = await this.requireTopicService().reject(
            request.clientId,
            request.id,
            request.token,
          );
          break;
      }
      const response: WorkResponse = {
        version: WORK_PROTOCOL_VERSION,
        kind: "response",
        id: request.id,
        ok: true,
        result,
      };
      this.writeMessage(client, response);
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.protocolFailure(client, error.requestId, error.code, error.message);
      } else if (error instanceof WorkDataError) {
        this.requestFailure(client, requestIdFromErrorFrame(text), error.code, error.message);
      } else {
        this.requestFailure(
          client,
          requestIdFromErrorFrame(text),
          "internal-error",
          "Daemon request failed.",
        );
      }
    }
  }

  private requireMainAgent(): MainAgentManager {
    if (this.options.mainAgent === undefined) {
      throw new WorkDataError("unavailable", "Main Agent control is not available.");
    }
    return this.options.mainAgent;
  }

  private requireTopicService(): TopicService {
    if (this.options.topicService === undefined) {
      throw new WorkDataError("unavailable", "Topic Service is not available.");
    }
    return this.options.topicService;
  }

  private requestFailure(
    client: ClientState,
    id: string | null,
    code: string,
    message: string,
  ): void {
    this.writeMessage(client, failure(id, code, message));
  }

  private protocolFailure(
    client: ClientState,
    id: string | null,
    code: string,
    message: string,
  ): void {
    client.parseErrors += 1;
    this.writeMessage(client, failure(id, code, message));
    if (client.parseErrors >= MAX_PARSE_ERRORS) client.socket.end();
  }

  private writeMessage(client: ClientState, message: ServerMessage): void {
    try {
      this.write(client, encodeMessage(message));
    } catch {
      client.socket.destroy();
    }
  }

  private write(client: ClientState, frame: string): void {
    if (client.socket.destroyed || client.socket.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      client.socket.destroy();
      return;
    }
    client.socket.write(frame);
  }
}

export function validateSocketPath(socketPath: string, runtimeDirectory?: string): void {
  if (!isAbsolute(socketPath)) throw new Error("Work daemon socket path must be absolute.");
  const runtime = runtimeDirectory ?? process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime.length === 0 || !isAbsolute(runtime)) {
    throw new Error("XDG_RUNTIME_DIR must be an absolute path.");
  }
  const normalizedRuntime = normalize(runtime);
  const normalizedSocket = normalize(socketPath);
  if (dirname(normalizedSocket) !== normalizedRuntime) {
    throw new Error("Work daemon socket must be directly inside XDG_RUNTIME_DIR.");
  }
}

async function removeOwnedStaleSocket(path: string, uid: number | undefined): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isSocket()) throw new Error("Refusing to replace a non-socket daemon path.");
    if (uid === undefined || stat.uid !== uid) {
      throw new Error("Refusing to remove a daemon socket owned by another user.");
    }
    if (await socketIsListening(path)) {
      throw new Error("A work daemon is already listening on the socket.");
    }
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function socketIsListening(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function requestIdFromErrorFrame(text: string): string | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const id = value["id"];
    return typeof id === "string" && id.length > 0 && id.length <= 100 ? id : null;
  } catch {
    return null;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
