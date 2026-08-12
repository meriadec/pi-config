import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { WorkDataError, boundMessage } from "../shared/domain.ts";
import type { MainAgentState, TopicManifest, TopicStore } from "../shared/index.ts";
import type { DesktopController, MainAgentActionResult } from "./desktop.ts";

const REGISTRATION_TTL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;

export interface MainAgentLease {
  topicId: string;
  sessionId: string;
  state: MainAgentState;
  connected: boolean;
  reason?: string;
}

export type MainAgentEvent = { type: "main-agent-changed"; agent: MainAgentLease };

interface Registration {
  token: string;
  topicId: string;
  sessionId: string;
  expiresAt: number;
}

interface LiveAgent extends MainAgentLease {
  connectionId?: string;
  lastHeartbeat?: number;
}

export interface MainAgentManagerOptions {
  topics: TopicStore;
  desktop: DesktopController;
  socketPath: string;
  now?: () => number;
  generateToken?: () => string;
  generateSessionId?: () => string;
  heartbeatTimeoutMs?: number;
  registrationTtlMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/** Owns one live Main Agent lease per Topic without reading Pi session content. */
export class MainAgentManager {
  private readonly leases = new Map<string, LiveAgent>();
  private readonly registrations = new Map<string, Registration>();
  private readonly listeners = new Set<(event: MainAgentEvent) => void>();
  private readonly now: () => number;
  private readonly heartbeatTimeoutMs: number;
  private readonly registrationTtlMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly options: MainAgentManagerOptions;

  constructor(options: MainAgentManagerOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.registrationTtlMs = options.registrationTtlMs ?? REGISTRATION_TTL_MS;
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    const hydration = await this.options.topics.list();
    for (const topic of hydration.topics) {
      if (!this.leases.has(topic.id)) {
        this.leases.set(topic.id, {
          topicId: topic.id,
          sessionId: topic.mainAgent.sessionId,
          state: "stopped",
          connected: false,
        });
      }
    }
    const start = this.options.setInterval ?? globalThis.setInterval;
    this.timer = start(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== undefined) {
      (this.options.clearInterval ?? globalThis.clearInterval)(this.timer);
      this.timer = undefined;
    }
    this.registrations.clear();
    this.leases.clear();
  }

  snapshot(): readonly MainAgentLease[] {
    return [...this.leases.values()]
      .map(publicLease)
      .toSorted((a, b) => a.topicId.localeCompare(b.topicId));
  }

  subscribe(listener: (event: MainAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reset(topic: TopicManifest): Promise<MainAgentActionResult> {
    if (
      this.options.desktop.closeMainAgent === undefined ||
      this.options.desktop.openMainAgent === undefined
    ) {
      throw new WorkDataError("unavailable", "Main Agent desktop control is not available.");
    }
    const closed = await this.options.desktop.closeMainAgent(topic.id);
    if (closed.kind === "unavailable") return closed;

    for (const [token, registration] of this.registrations) {
      if (registration.topicId === topic.id) this.registrations.delete(token);
    }
    const sessionId = (this.options.generateSessionId ?? randomUUID)();
    const updated = await this.options.topics.update(topic.id, (current) => ({
      ...current,
      mainAgent: { sessionId, sessionFile: null },
    }));
    this.change(topic.id, { sessionId, state: "stopped", connected: false });
    return this.open(updated);
  }

  async open(topic: TopicManifest): Promise<MainAgentActionResult> {
    if (this.options.desktop.openMainAgent === undefined) {
      throw new WorkDataError("unavailable", "Main Agent desktop control is not available.");
    }
    const token = (this.options.generateToken ?? randomUUID)();
    this.registrations.set(token, {
      token,
      topicId: topic.id,
      sessionId: topic.mainAgent.sessionId,
      expiresAt: this.now() + this.registrationTtlMs,
    });
    const previous = this.leases.get(topic.id);
    this.change(topic.id, {
      sessionId: topic.mainAgent.sessionId,
      state: "starting",
      connected: false,
    });
    try {
      const result = await this.options.desktop.openMainAgent({
        topicId: topic.id,
        topicName: topic.name,
        worktreePath: topic.worktreePath!,
        sessionId: topic.mainAgent.sessionId,
        socketPath: this.options.socketPath,
        registrationToken: token,
      });
      if (result.kind !== "launched") this.registrations.delete(token);
      if (result.kind === "focused" && previous !== undefined) {
        this.change(topic.id, { ...previous });
      } else if (result.kind === "focused") {
        this.change(topic.id, {
          sessionId: topic.mainAgent.sessionId,
          state: "stopped",
          connected: false,
        });
      } else if (result.kind === "unavailable") {
        this.fail(topic.id, result.message);
      }
      return result;
    } catch (error) {
      this.registrations.delete(token);
      this.fail(topic.id, error instanceof Error ? error.message : "Main Agent launch failed.");
      throw error;
    }
  }

  async register(input: {
    connectionId: string;
    topicId: string;
    sessionId: string;
    sessionFile: string;
    token: string;
  }): Promise<MainAgentLease> {
    const registration = this.registrations.get(input.token);
    if (
      registration === undefined ||
      registration.expiresAt <= this.now() ||
      registration.topicId !== input.topicId ||
      registration.sessionId !== input.sessionId
    ) {
      throw new WorkDataError(
        "invalid-registration",
        "Main Agent registration token is invalid or expired.",
      );
    }
    if (!isAbsolute(input.sessionFile) || input.sessionFile.length > 1_000) {
      throw new WorkDataError("invalid-session-file", "Main Agent session file path is invalid.");
    }
    const topic = await this.options.topics.load(input.topicId);
    if (topic.mainAgent.sessionId !== input.sessionId) {
      throw new WorkDataError(
        "invalid-agent-identity",
        "Main Agent session identity does not match the Topic.",
      );
    }
    const current = this.leases.get(input.topicId);
    if (
      current?.connected === true &&
      current.connectionId !== input.connectionId &&
      current.sessionId !== input.sessionId
    ) {
      throw new WorkDataError(
        "agent-already-connected",
        "A different Main Agent is already connected for this Topic.",
      );
    }
    if (topic.mainAgent.sessionFile !== input.sessionFile) {
      const updated = await this.options.topics.update(topic.id, (value) => ({
        ...value,
        mainAgent: { ...value.mainAgent, sessionFile: input.sessionFile },
      }));
      void updated;
    }
    return this.change(input.topicId, {
      sessionId: input.sessionId,
      state: "idle",
      connected: true,
      connectionId: input.connectionId,
      lastHeartbeat: this.now(),
    });
  }

  transition(
    connectionId: string,
    state: "thinking" | "waiting-for-human" | "stopped",
    reason?: string,
  ): MainAgentLease {
    const agent = this.requireConnection(connectionId);
    if (state === "stopped") {
      return this.change(agent.topicId, {
        sessionId: agent.sessionId,
        state,
        connected: false,
        ...(reason === undefined ? {} : { reason: boundMessage(reason) }),
      });
    }
    return this.change(agent.topicId, {
      ...agent,
      state,
      connected: true,
      ...(reason === undefined ? {} : { reason: boundMessage(reason) }),
    });
  }

  heartbeat(connectionId: string): MainAgentLease {
    const agent = this.requireConnection(connectionId);
    agent.lastHeartbeat = this.now();
    return publicLease(agent);
  }

  disconnected(connectionId: string): void {
    const agent = [...this.leases.values()].find((item) => item.connectionId === connectionId);
    if (agent === undefined || agent.state === "stopped") return;
    // Keep the lease until heartbeat expiry so the same session can reconnect.
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, registration] of this.registrations) {
      if (registration.expiresAt <= now) this.registrations.delete(token);
    }
    for (const agent of this.leases.values()) {
      if (
        agent.connected &&
        agent.lastHeartbeat !== undefined &&
        now - agent.lastHeartbeat > this.heartbeatTimeoutMs
      ) {
        this.fail(agent.topicId, "Main Agent heartbeat expired.");
      }
    }
  }

  private requireConnection(connectionId: string): LiveAgent {
    const agent = [...this.leases.values()].find((item) => item.connectionId === connectionId);
    if (agent === undefined || !agent.connected) {
      throw new WorkDataError("agent-not-registered", "Main Agent connection is not registered.");
    }
    return agent;
  }

  private fail(topicId: string, reason: string): void {
    const current = this.leases.get(topicId);
    if (current === undefined) return;
    this.change(topicId, {
      sessionId: current.sessionId,
      state: "failed",
      connected: false,
      reason: boundMessage(reason),
    });
  }

  private change(topicId: string, value: Omit<LiveAgent, "topicId">): MainAgentLease {
    const agent: LiveAgent = { topicId, ...value };
    this.leases.set(topicId, agent);
    const result = publicLease(agent);
    for (const listener of this.listeners) listener({ type: "main-agent-changed", agent: result });
    return result;
  }
}

function publicLease(agent: LiveAgent): MainAgentLease {
  return {
    topicId: agent.topicId,
    sessionId: agent.sessionId,
    state: agent.state,
    connected: agent.connected,
    ...(agent.reason === undefined ? {} : { reason: agent.reason }),
  };
}
