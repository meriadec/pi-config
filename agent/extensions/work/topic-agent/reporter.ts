import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { WorkClient } from "../client/client.ts";

const DEFAULT_HEARTBEAT_MS = 5_000;

export interface TopicAgentEnvironment {
  topicId: string;
  socketPath: string;
  registrationToken: string;
  sessionId: string;
}

interface AgentClient {
  registerMainAgent(input: {
    topicId: string;
    sessionId: string;
    sessionFile: string;
    token: string;
  }): Promise<unknown>;
  heartbeatMainAgent(): Promise<unknown>;
  reportMainAgent(state: "thinking" | "waiting" | "stopped"): Promise<unknown>;
  close(): void;
}

export interface TopicAgentReporterOptions {
  environment?: NodeJS.ProcessEnv;
  connect?: (socketPath: string) => Promise<AgentClient>;
  heartbeatMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
}

/** Maps one topic-aware Pi session lifecycle to bounded workd telemetry. */
export class TopicAgentReporter {
  private readonly environment: TopicAgentEnvironment | undefined;
  private client: AgentClient | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatPending = false;
  private registration:
    | { topicId: string; sessionId: string; sessionFile: string; token: string }
    | undefined;
  private shuttingDown = false;
  private readonly connect: (socketPath: string) => Promise<AgentClient>;
  private readonly heartbeatMs: number;

  constructor(options: TopicAgentReporterOptions = {}) {
    this.environment = readTopicAgentEnvironment(options.environment ?? process.env);
    this.connect = options.connect ?? ((path) => WorkClient.connect(path));
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.startTimer = options.setInterval ?? globalThis.setInterval;
    this.stopTimer = options.clearInterval ?? globalThis.clearInterval;
    this.startSettleTimer = options.setTimeout ?? globalThis.setTimeout;
    this.stopSettleTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  private readonly startTimer: typeof globalThis.setInterval;
  private readonly stopTimer: typeof globalThis.clearInterval;
  private readonly startSettleTimer: typeof globalThis.setTimeout;
  private readonly stopSettleTimer: typeof globalThis.clearTimeout;

  get enabled(): boolean {
    return this.environment !== undefined;
  }

  async sessionStart(ctx: Pick<ExtensionContext, "sessionManager">): Promise<void> {
    const environment = this.environment;
    if (environment === undefined) return;
    await this.close(false);
    const sessionFile = ctx.sessionManager.getSessionFile();
    const actualSessionId = ctx.sessionManager.getSessionId();
    if (sessionFile === undefined || actualSessionId !== environment.sessionId) return;
    this.shuttingDown = false;
    this.registration = {
      topicId: environment.topicId,
      sessionId: actualSessionId,
      sessionFile,
      token: environment.registrationToken,
    };
    const client = await this.connect(environment.socketPath);
    try {
      await client.registerMainAgent(this.registration);
    } catch (error) {
      client.close();
      throw error;
    }
    this.client = client;
    this.timer = this.startTimer(() => {
      const activeClient = this.client;
      if (this.heartbeatPending || activeClient === undefined) return;
      this.heartbeatPending = true;
      void activeClient
        .heartbeatMainAgent()
        .catch(async () => {
          activeClient.close();
          if (this.client === activeClient) this.client = undefined;
          await this.reconnect();
        })
        .finally(() => {
          this.heartbeatPending = false;
        });
    }, this.heartbeatMs);
  }

  async thinking(): Promise<void> {
    this.clearSettleTimer();
    await this.client?.reportMainAgent("thinking");
  }

  settleWhenIdle(isIdle: () => boolean): void {
    this.clearSettleTimer();
    this.settleTimer = this.startSettleTimer(() => {
      this.settleTimer = undefined;
      if (isIdle()) void this.waiting();
    }, 0);
  }

  async waiting(): Promise<void> {
    this.clearSettleTimer();
    await this.client?.reportMainAgent("waiting");
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.close(true);
    this.registration = undefined;
  }

  private async reconnect(): Promise<void> {
    const environment = this.environment;
    const registration = this.registration;
    if (this.shuttingDown || environment === undefined || registration === undefined) return;
    try {
      const client = await this.connect(environment.socketPath);
      await client.registerMainAgent(registration);
      if (this.shuttingDown) {
        client.close();
        return;
      }
      this.client = client;
    } catch {
      // workd will report failed if the bounded heartbeat deadline expires.
    }
  }

  private async close(reportStopped: boolean): Promise<void> {
    this.clearSettleTimer();
    if (this.timer !== undefined) {
      this.stopTimer(this.timer);
      this.timer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    if (client === undefined) return;
    if (reportStopped) await client.reportMainAgent("stopped").catch(() => undefined);
    client.close();
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === undefined) return;
    this.stopSettleTimer(this.settleTimer);
    this.settleTimer = undefined;
  }
}

export function readTopicAgentEnvironment(
  env: NodeJS.ProcessEnv,
): TopicAgentEnvironment | undefined {
  const topicId = env["PI_WORK_TOPIC_ID"];
  const socketPath = env["PI_WORK_SOCKET"];
  const registrationToken = env["PI_WORK_REGISTRATION_TOKEN"];
  const sessionId = env["PI_WORK_SESSION_ID"];
  if (
    topicId === undefined ||
    topicId.length === 0 ||
    socketPath === undefined ||
    !socketPath.startsWith("/") ||
    registrationToken === undefined ||
    registrationToken.length === 0 ||
    sessionId === undefined ||
    sessionId.length === 0
  ) {
    return undefined;
  }
  return { topicId, socketPath, registrationToken, sessionId };
}

export function registerTopicAgentTelemetry(
  pi: ExtensionAPI,
  reporter = new TopicAgentReporter(),
): void {
  pi.on("session_start", async (_event, ctx) => reporter.sessionStart(ctx));
  pi.on("agent_start", async () => reporter.thinking());
  // agent_settled exists at runtime in Pi 0.80, but its published ExtensionAPI type omits it.
  const lifecycle = pi as ExtensionAPI & {
    on(event: "agent_settled", handler: () => Promise<void>): void;
  };
  lifecycle.on("agent_settled", async () => reporter.waiting());
  // Pi 0.80 runtimes without agent_settled use this idle-checked fallback.
  pi.on("agent_end", async (_event, ctx) => reporter.settleWhenIdle(() => ctx.isIdle()));
  pi.on("session_shutdown", async () => reporter.shutdown());
}
