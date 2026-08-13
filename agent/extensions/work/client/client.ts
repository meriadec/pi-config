import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import {
  MAX_FRAME_BYTES,
  NdjsonDecoder,
  WORK_PROTOCOL_VERSION,
  encodeMessage,
  type DaemonSnapshot,
  type PingResult,
  type RequestAction,
  type SubscriptionSnapshot,
  type WorkEvent,
  type WorkRequest,
} from "../daemon/protocol.ts";
import { boundMessage } from "../shared/domain.ts";
import type { NewTopic } from "../shared/domain.ts";
import type { MainAgentActionResult, WorkspaceActionResult } from "../daemon/desktop.ts";
import type { MainAgentLease } from "../daemon/main-agent.ts";
import type { TopicMutationResult, WorkActionResult } from "../daemon/topic-service.ts";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WorkClientConnectOptions {
  timeoutMs?: number;
  clientId?: string;
}

export class WorkClient {
  private readonly decoder = new NdjsonDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private eventHandler: ((event: WorkEvent) => void) | undefined;
  private eventRevision = -1;
  private queuedEvents: Array<{ revision: number; event: WorkEvent }> = [];
  private readonly disconnectHandlers = new Set<(error: Error) => void>();
  private disconnected = false;
  private nextId = 1;
  private readonly clientId: string;
  private closed = false;
  private readonly socket: Socket;

  private constructor(socket: Socket, clientId: string) {
    this.socket = socket;
    this.clientId = clientId;
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => this.failAll(error));
    socket.on("close", () => this.failAll(new Error("Work daemon connection closed.")));
  }

  static async connect(
    socketPath: string,
    options: WorkClientConnectOptions = {},
  ): Promise<WorkClient> {
    const timeoutMs = options.timeoutMs ?? 1_000;
    const socket = createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Timed out while connecting to work daemon."));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", onError);
        resolve();
      });
      const onError = (error: Error): void => {
        clearTimeout(timer);
        reject(error);
      };
      socket.once("error", onError);
    });
    return new WorkClient(socket, options.clientId ?? randomUUID());
  }

  ping(timeoutMs?: number): Promise<PingResult> {
    return this.request("ping", {}, timeoutMs) as Promise<PingResult>;
  }

  snapshot(timeoutMs?: number): Promise<DaemonSnapshot> {
    return this.request("snapshot", {}, timeoutMs) as Promise<DaemonSnapshot>;
  }

  createTopic(
    input: NewTopic,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    return this.request(
      "topic.create",
      { input },
      timeoutMs,
      requestId,
    ) as Promise<TopicMutationResult>;
  }

  retryTopic(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    return this.request(
      "topic.retry",
      { topicId },
      timeoutMs,
      requestId,
    ) as Promise<TopicMutationResult>;
  }

  deleteTopic(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    return this.request(
      "topic.delete",
      { topicId },
      timeoutMs,
      requestId,
    ) as Promise<TopicMutationResult>;
  }

  accessWorkspace(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<WorkspaceActionResult> {
    return this.request(
      "workspace.access",
      { topicId },
      timeoutMs,
      requestId,
    ) as Promise<WorkspaceActionResult>;
  }

  openTerminal(topicId: string, requestId?: string, timeoutMs?: number): Promise<WorkActionResult> {
    return this.request(
      "terminal.open",
      { topicId },
      timeoutMs,
      requestId,
    ) as Promise<WorkActionResult>;
  }

  openMainAgent(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    return this.request("agent.open", { topicId }, timeoutMs, requestId) as Promise<
      MainAgentActionResult | WorkActionResult
    >;
  }

  resetMainAgent(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    return this.request("agent.reset", { topicId }, timeoutMs, requestId) as Promise<
      MainAgentActionResult | WorkActionResult
    >;
  }

  openPullRequest(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<WorkActionResult> {
    return this.request(
      "pull-request.open",
      { topicId },
      timeoutMs,
      requestId,
    ) as Promise<WorkActionResult>;
  }

  registerMainAgent(
    input: {
      topicId: string;
      sessionId: string;
      sessionFile: string;
      token: string;
      affiliationToken?: string;
    },
    timeoutMs?: number,
  ): Promise<MainAgentLease> {
    return this.request("agent.register", input, timeoutMs) as Promise<MainAgentLease>;
  }

  heartbeatMainAgent(timeoutMs?: number): Promise<MainAgentLease> {
    return this.request("agent.heartbeat", {}, timeoutMs) as Promise<MainAgentLease>;
  }

  reportMainAgent(
    state: "thinking" | "waiting" | "stopped",
    timeoutMs?: number,
  ): Promise<MainAgentLease> {
    return this.request(
      `agent.${state}` as RequestAction,
      {},
      timeoutMs,
    ) as Promise<MainAgentLease>;
  }

  confirm<T extends WorkActionResult = TopicMutationResult>(
    token: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<T> {
    return this.request("action.confirm", { token }, timeoutMs, requestId) as Promise<T>;
  }

  reject(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult> {
    return this.request(
      "action.reject",
      { token },
      timeoutMs,
      requestId,
    ) as Promise<TopicMutationResult>;
  }

  async subscribe(
    handler: (event: WorkEvent) => void,
    timeoutMs?: number,
  ): Promise<DaemonSnapshot> {
    this.eventHandler = handler;
    try {
      const result = (await this.request("subscribe", {}, timeoutMs)) as SubscriptionSnapshot;
      if (result?.subscribed !== true || result.snapshot === undefined) {
        throw new Error("Work daemon returned an invalid subscription snapshot.");
      }
      this.eventRevision = result.snapshot.revision;
      for (const queued of this.queuedEvents) this.deliverEvent(queued.revision, queued.event);
      this.queuedEvents = [];
      return result.snapshot;
    } catch (error) {
      this.eventHandler = undefined;
      throw error;
    }
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.failAll(new Error("Work daemon client closed."));
  }

  private request(
    action: RequestAction,
    fields: Record<string, unknown> = {},
    timeoutMs = 2_000,
    requestedId?: string,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Work daemon client is closed."));
    const id = requestedId ?? String(this.nextId++);
    const request = {
      version: WORK_PROTOCOL_VERSION,
      kind: "request",
      id,
      clientId: this.clientId,
      action,
      ...fields,
    } as WorkRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Work daemon ${action} request timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(encodeMessage(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("Work daemon request failed."));
      }
    });
  }

  private receive(chunk: Buffer): void {
    for (const frame of this.decoder.feed(chunk)) {
      if (!frame.ok) {
        this.closeWithError(new Error(frame.message));
        return;
      }
      let input: unknown;
      try {
        input = JSON.parse(frame.text);
      } catch {
        this.closeWithError(new Error("Work daemon sent invalid JSON."));
        return;
      }
      if (input === null || typeof input !== "object" || Array.isArray(input)) {
        this.closeWithError(new Error("Work daemon sent an invalid message."));
        return;
      }
      const message = input as Record<string, unknown>;
      if (message["version"] !== WORK_PROTOCOL_VERSION) {
        this.closeWithError(new Error("Work daemon uses an unsupported protocol version."));
        return;
      }
      if (message["kind"] === "event") {
        const event = message["event"];
        const revision = message["revision"];
        if (isWorkEvent(event) && typeof revision === "number" && Number.isSafeInteger(revision)) {
          if (this.eventHandler !== undefined && this.eventRevision < 0) {
            this.queuedEvents.push({ revision, event });
          } else {
            this.deliverEvent(revision, event);
          }
        }
        continue;
      }
      if (message["kind"] !== "response" || typeof message["id"] !== "string") continue;
      const pending = this.pending.get(message["id"]);
      if (pending === undefined) continue;
      this.pending.delete(message["id"]);
      clearTimeout(pending.timer);
      if (message["ok"] === true) {
        pending.resolve(message["result"]);
      } else {
        const error = message["error"];
        const text =
          error !== null &&
          typeof error === "object" &&
          typeof (error as Record<string, unknown>)["message"] === "string"
            ? String((error as Record<string, unknown>)["message"])
            : "Work daemon request failed.";
        const code =
          error !== null &&
          typeof error === "object" &&
          typeof (error as Record<string, unknown>)["code"] === "string"
            ? String((error as Record<string, unknown>)["code"])
            : "request-failed";
        pending.reject(new WorkClientError(code, boundMessage(text)));
      }
    }
  }

  private deliverEvent(revision: number, event: WorkEvent): void {
    if (revision <= this.eventRevision) return;
    this.eventRevision = revision;
    this.eventHandler?.(event);
  }

  private closeWithError(error: Error): void {
    this.closed = true;
    this.socket.destroy();
    this.failAll(error);
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.disconnected) return;
    this.disconnected = true;
    for (const handler of this.disconnectHandlers) handler(error);
  }
}

export class WorkClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkClientError";
    this.code = code;
  }
}

function isWorkEvent(value: unknown): value is WorkEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as Record<string, unknown>)["type"];
  return (
    type === "snapshot-changed" ||
    type === "daemon-stopping" ||
    type === "topic-added" ||
    type === "setup-changed" ||
    type === "topic-changed" ||
    type === "topic-removed" ||
    type === "diagnostic-added" ||
    type === "workspace-accessed" ||
    type === "terminal-opened" ||
    type === "main-agent-opened" ||
    type === "main-agent-changed" ||
    type === "pull-request-changed" ||
    type === "operation-changed"
  );
}

export { MAX_FRAME_BYTES };
