import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DELEGATION_ACTIVITY_EVENT_V1,
  isDelegationActivityEventV1,
} from "../../sub/activity-events.ts";
import { TRACK_PR_ACTIVITY_EVENT, isTrackPrActivityEvent } from "../shared/activity-events.ts";
import type { MainAgentActivity } from "../domain/index.ts";
import type { WorkClientRuntime } from "../client/effect-runtime.ts";
import { readTopicAgentEnvironment, type TopicAgentEnvironment } from "./environment.ts";

const DEFAULT_HEARTBEAT_MS = 5_000;

type VisibleActivity = "thinking" | "thinking-sub" | "tracking-pr" | "waiting-for-human";

export interface EffectTopicAgentReporterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly makeRuntime?: (socketPath: string) => WorkClientRuntime;
  readonly heartbeatMs?: number;
  readonly setSessionName?: (name: string) => void;
  readonly log?: (message: string) => void;
}

/**
 * Topic Agent adapter for the Effect RPC client. It is lazy: an ordinary or Delegation Job
 * session never constructs a Work runtime. One scoped sequential schedule owns heartbeat,
 * re-registration, retry, and activity reassertion until session shutdown.
 */
export class EffectTopicAgentReporter {
  private readonly environment: TopicAgentEnvironment | undefined;
  private readonly makeRuntime: ((socketPath: string) => WorkClientRuntime) | undefined;
  private readonly heartbeatMs: number;
  private readonly setSessionName: ((name: string) => void) | undefined;
  private readonly log: (message: string) => void;
  private runtime: WorkClientRuntime | undefined;
  private stopSchedule: (() => void) | undefined;
  private connectionId = randomUUID();
  private registration:
    | { readonly sessionId: string; readonly sessionFile: string; readonly adopting: boolean }
    | undefined;
  private registered = false;
  private pending = false;
  private shuttingDown = false;
  private mainThinking = false;
  private delegationActive = false;
  private trackingActive = false;
  private lastReported: VisibleActivity | undefined;

  constructor(options: EffectTopicAgentReporterOptions = {}) {
    this.environment = readTopicAgentEnvironment(options.environment ?? process.env);
    this.makeRuntime = options.makeRuntime;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.setSessionName = options.setSessionName;
    this.log = options.log ?? ((message) => console.error(`pi-work topic agent: ${message}`));
  }

  get enabled(): boolean {
    return this.environment !== undefined;
  }

  async sessionStart(ctx: Pick<ExtensionContext, "sessionManager" | "isIdle">): Promise<void> {
    const environment = this.environment;
    if (environment === undefined) return;
    await this.close(false);
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionFile === undefined) return;
    const adopting = sessionId !== environment.sessionId;
    if (adopting && environment.affiliationToken === undefined) return;

    this.shuttingDown = false;
    this.registered = false;
    this.connectionId = randomUUID();
    this.registration = { sessionId, sessionFile, adopting };
    this.mainThinking = !ctx.isIdle();
    this.lastReported = undefined;
    this.runtime =
      this.makeRuntime?.(environment.socketPath) ??
      (await import("../client/effect-runtime.ts")).makeWorkClientRuntime({
        socketPath: environment.socketPath,
      });
    this.stopSchedule = this.runtime.repeat(this.heartbeatMs, () => void this.cycle());
    await this.cycle();

    const desiredName =
      environment.topicName === undefined ? undefined : `Work: ${environment.topicName}`;
    if (desiredName !== undefined && ctx.sessionManager.getSessionName() !== desiredName) {
      this.setSessionName?.(desiredName);
    }
  }

  async thinking(): Promise<void> {
    this.mainThinking = true;
    await this.reportEffectiveActivity();
  }

  async waiting(): Promise<void> {
    this.mainThinking = false;
    await this.reportEffectiveActivity();
  }

  async delegationActivity(active: boolean): Promise<void> {
    this.delegationActive = active;
    await this.reportEffectiveActivity();
  }

  async trackingPr(active: boolean): Promise<void> {
    this.trackingActive = active;
    await this.reportEffectiveActivity();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.close(true);
    this.registration = undefined;
  }

  private async cycle(): Promise<void> {
    if (this.pending || this.shuttingDown || this.runtime === undefined) return;
    this.pending = true;
    try {
      if (!this.registered) await this.register();
      else
        await this.runtime.mainAgentCall({ action: "heartbeat", connectionId: this.connectionId });
    } catch (error) {
      this.registered = false;
      this.log(`re-attach failed: ${error instanceof Error ? error.message : "unknown error"}`);
    } finally {
      this.pending = false;
    }
  }

  private async register(): Promise<void> {
    const { decodeAbsolutePath, decodeTopicId } = await import("../domain/index.ts");
    const environment = this.environment!;
    const registration = this.registration!;
    const common = {
      connectionId: this.connectionId,
      topicId: decodeTopicId(environment.topicId),
      sessionId: registration.sessionId,
      sessionFile: decodeAbsolutePath(registration.sessionFile),
    };
    if (registration.adopting) {
      await this.runtime!.mainAgentCall({
        action: "adopt",
        ...common,
        capability: environment.affiliationToken!,
      });
    } else {
      try {
        await this.runtime!.mainAgentCall({
          action: "register",
          ...common,
          capability: environment.registrationToken,
        });
      } catch (error) {
        if (environment.affiliationToken === undefined) throw error;
        await this.runtime!.mainAgentCall({
          action: "adopt",
          ...common,
          capability: environment.affiliationToken,
        });
      }
    }
    this.registered = true;
    this.lastReported = undefined;
    await this.reportEffectiveActivity();
  }

  private effectiveActivity(): VisibleActivity {
    if (this.mainThinking) return "thinking";
    if (this.delegationActive) return "thinking-sub";
    return this.trackingActive ? "tracking-pr" : "waiting-for-human";
  }

  private async reportEffectiveActivity(): Promise<void> {
    const activity = this.effectiveActivity();
    if (!this.registered || this.runtime === undefined || activity === this.lastReported) return;
    this.lastReported = activity;
    try {
      await this.runtime.mainAgentCall({
        action: "report",
        connectionId: this.connectionId,
        activity: activity as MainAgentActivity,
      });
    } catch (error) {
      this.registered = false;
      this.lastReported = undefined;
      this.log(
        `activity report failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  private async close(reportStopped: boolean): Promise<void> {
    this.stopSchedule?.();
    this.stopSchedule = undefined;
    const runtime = this.runtime;
    this.runtime = undefined;
    if (runtime === undefined) return;
    if (reportStopped && this.registered) {
      await runtime
        .mainAgentCall({ action: "report", connectionId: this.connectionId, activity: "stopped" })
        .catch(() => undefined);
    }
    this.registered = false;
    await runtime.dispose();
  }
}

/** Registers the lazy Effect Topic Agent adapter at the Pi lifecycle boundary. */
export function registerEffectTopicAgentTelemetry(
  pi: ExtensionAPI,
  reporter = new EffectTopicAgentReporter({ setSessionName: (name) => pi.setSessionName(name) }),
): void {
  const stopTracking = pi.events.on(TRACK_PR_ACTIVITY_EVENT, (data) => {
    if (isTrackPrActivityEvent(data)) void reporter.trackingPr(data.active);
  });
  const stopDelegation = pi.events.on(DELEGATION_ACTIVITY_EVENT_V1, (data) => {
    if (isDelegationActivityEventV1(data)) void reporter.delegationActivity(data.active);
  });
  pi.on("session_start", async (_event, ctx) => reporter.sessionStart(ctx));
  pi.on("agent_start", async () => reporter.thinking());
  const lifecycle = pi as ExtensionAPI & {
    on(event: "agent_settled", handler: () => Promise<void>): void;
  };
  lifecycle.on("agent_settled", async () => reporter.waiting());
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.isIdle()) await reporter.waiting();
  });
  pi.on("session_shutdown", async () => {
    stopTracking();
    stopDelegation();
    await reporter.shutdown();
  });
}
