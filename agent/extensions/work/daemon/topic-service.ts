import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  WorkDataError,
  boundMessage,
  isValidBranchName,
  parseRepository,
  resolveActionPolicy,
} from "../shared/index.ts";
import type {
  ActionId,
  ConfigStore,
  NewTopic,
  PullRequestRef,
  TopicDiagnostic,
  TopicManifest,
  TopicStore,
  WorkConfig,
} from "../shared/index.ts";
import type {
  DesktopController,
  MainAgentActionResult,
  PullRequestActionResult,
  TerminalActionResult,
  WorkspaceActionResult,
} from "./desktop.ts";
import type { MainAgentManager } from "./main-agent.ts";
import type { PullRequestObserver } from "./pull-request-observer.ts";
import type { ProvisionRequest, ProvisionResult, TopicProvisioner } from "./provisioner.ts";

const CONFIRMATION_TTL_MS = 60_000;
const MAX_DEDUPLICATED_REQUESTS = 1_000;
const PULL_REQUEST_POLL_INTERVAL_MS = 60_000;

export interface TopicOperation {
  topicId: string;
  kind:
    | "provision"
    | "delete"
    | "access-workspace"
    | "open-terminal"
    | "open-agent"
    | "reset-agent";
  state: "running" | "confirmation-required";
  /** Live sub-step, for example a `setup N/M` Repository Recipe phase. */
  detail?: string;
}

export interface TopicServiceSnapshot {
  topics: readonly TopicManifest[];
  diagnostics: readonly TopicDiagnostic[];
  operations: readonly TopicOperation[];
  baseCheckouts: Readonly<Record<string, string>>;
  deniedActions: Readonly<Record<string, readonly ActionId[]>>;
  pullRequests: Readonly<Record<string, PullRequestRef>>;
}

export type TopicServiceEvent =
  | { type: "topic-added"; topic: TopicManifest }
  | { type: "setup-changed"; topic: TopicManifest }
  | { type: "topic-changed"; topic: TopicManifest }
  | { type: "topic-removed"; topicId: string }
  | { type: "diagnostic-added"; diagnostic: TopicDiagnostic }
  | { type: "workspace-accessed"; topicId: string; result: WorkspaceActionResult }
  | { type: "terminal-opened"; topicId: string; result: TerminalActionResult }
  | { type: "main-agent-opened"; topicId: string; result: MainAgentActionResult }
  | { type: "pull-request-changed"; topicId: string; pullRequest: PullRequestRef | null }
  | { type: "operation-changed"; topicId: string; operation: TopicOperation | null };

export interface ConfirmationRequirement {
  status: "confirmation-required";
  token: string;
  action: ActionId;
  topicId: string;
  expiresAt: string;
  text: string;
}

export type TopicMutationResult =
  | { status: "ready"; topic: TopicManifest }
  | { status: "renamed"; topic: TopicManifest }
  | { status: "deleted"; topicId: string }
  | { status: "rejected"; topicId: string }
  | { status: "denied" | "failed" | "timeout" | "cancelled"; reason: string; topic: TopicManifest }
  | ConfirmationRequirement;

export type WorkActionResult =
  | TopicMutationResult
  | WorkspaceActionResult
  | TerminalActionResult
  | MainAgentActionResult
  | PullRequestActionResult;

interface PendingConfirmation {
  token: string;
  clientId: string;
  originalRequest: string;
  topicId: string;
  action: ActionId;
  expiresAtMs: number;
  operation: "provision" | "delete" | "terminal" | "agent" | "reset-agent";
  approvedActions: ReadonlySet<ActionId>;
}

export interface TopicServiceOptions {
  config: ConfigStore;
  topics: TopicStore;
  provisioner: Pick<TopicProvisioner, "provision">;
  desktop?: DesktopController;
  mainAgent?: MainAgentManager;
  pullRequests?: PullRequestObserver;
  now?: () => Date;
  confirmationTtlMs?: number;
  generateToken?: () => string;
  pullRequestPollIntervalMs?: number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

/** Owns durable Topic mutations and live daemon operation state. */
export class TopicService {
  private config: WorkConfig | null = null;
  private readonly topicById = new Map<string, TopicManifest>();
  private diagnostics: TopicDiagnostic[] = [];
  private readonly operations = new Map<string, TopicOperation>();
  private readonly pullRequestById = new Map<string, PullRequestRef>();
  private pullRequestTimer: ReturnType<typeof setInterval> | undefined;
  private readonly topicQueues = new Map<string, Promise<void>>();
  private readonly confirmations = new Map<string, PendingConfirmation>();
  private readonly deduplicated = new Map<
    string,
    { fingerprint: string; result: Promise<WorkActionResult> }
  >();
  private readonly listeners = new Set<(event: TopicServiceEvent) => void>();
  private readonly options: TopicServiceOptions;
  private started = false;
  private readonly now: () => Date;
  private readonly confirmationTtlMs: number;
  private readonly generateToken: () => string;
  private readonly pullRequestPollIntervalMs: number;

  constructor(options: TopicServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.confirmationTtlMs = options.confirmationTtlMs ?? CONFIRMATION_TTL_MS;
    this.generateToken = options.generateToken ?? randomUUID;
    this.pullRequestPollIntervalMs =
      options.pullRequestPollIntervalMs ?? PULL_REQUEST_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const [config, hydration] = await Promise.all([
      this.options.config.load(),
      this.options.topics.list(),
    ]);
    this.config = config;
    for (const topic of hydration.topics) this.topicById.set(topic.id, topic);
    this.diagnostics = [...hydration.diagnostics];
    for (const diagnostic of hydration.diagnostics) {
      this.emit({ type: "diagnostic-added", diagnostic });
    }

    if (config?.workBase !== undefined) {
      for (const topic of hydration.topics) {
        // Re-run the idempotent provisioner for interrupted checkpoints and ready claims.
        // This verifies base checkout identity and replaces stale wt-owned paths on restart.
        if (topic.setup.state === "provisioning" || topic.setup.state === "ready") {
          void this.provision(topic.id, "startup", new Set(), "startup").catch(() => undefined);
        }
      }
    }

    if (this.options.pullRequests !== undefined && this.pullRequestTimer === undefined) {
      const start = this.options.setInterval ?? globalThis.setInterval;
      this.pullRequestTimer = start(() => {
        void this.refreshAllPullRequests();
      }, this.pullRequestPollIntervalMs);
      void this.refreshAllPullRequests();
    }
  }

  stop(): void {
    if (this.pullRequestTimer !== undefined) {
      (this.options.clearInterval ?? globalThis.clearInterval)(this.pullRequestTimer);
      this.pullRequestTimer = undefined;
    }
  }

  snapshot(): TopicServiceSnapshot {
    return {
      topics: [...this.topicById.values()].toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
      diagnostics: [...this.diagnostics],
      operations: [...this.operations.values()],
      baseCheckouts: Object.fromEntries(
        [...this.topicById.values()].map((topic) => [
          topic.id,
          this.config?.workBase === undefined
            ? "not configured"
            : join(this.config.workBase, parseRepository(topic.repository).name),
        ]),
      ),
      deniedActions: Object.fromEntries(
        [...this.topicById.values()].map((topic) => [
          topic.id,
          deniedTopicActions(this.config, topic),
        ]),
      ),
      pullRequests: Object.fromEntries(this.pullRequestById),
    };
  }

  subscribe(listener: (event: TopicServiceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async refreshTopic(topicId: string): Promise<TopicManifest> {
    const topic = await this.options.topics.load(topicId);
    this.topicById.set(topic.id, topic);
    this.emit({ type: "topic-changed", topic });
    return topic;
  }

  private async refreshAllPullRequests(): Promise<void> {
    for (const topicId of Array.from(this.topicById.keys())) {
      await this.refreshPullRequest(topicId);
    }
  }

  private async refreshPullRequest(topicId: string): Promise<void> {
    const observer = this.options.pullRequests;
    if (observer === undefined) return;
    const topic = this.topicById.get(topicId);
    const worktreePath = topic?.worktreePath ?? null;
    const next =
      topic === undefined || topic.setup.state !== "ready" || worktreePath === null
        ? null
        : await observer
            .discover({ ...prTarget(topic.repository), branch: topic.branch, worktreePath })
            .catch(() => null);
    const current = this.pullRequestById.get(topicId) ?? null;
    if (samePullRequest(current, next)) return;
    if (next === null) this.pullRequestById.delete(topicId);
    else this.pullRequestById.set(topicId, next);
    this.emit({ type: "pull-request-changed", topicId, pullRequest: next });
  }

  create(clientId: string, requestId: string, input: NewTopic): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `create:${JSON.stringify(input)}`, async () => {
      if (input.name.trim().length === 0) {
        throw new WorkDataError("invalid-topic", "Topic name must not be empty.");
      }
      parseRepository(input.repository);
      if (!isValidBranchName(input.branch)) {
        throw new WorkDataError("invalid-topic", "Topic branch is not a valid Git branch name.");
      }
      this.requireConfigured();
      const topic = await this.options.topics.create(input);
      this.topicById.set(topic.id, topic);
      this.emit({ type: "topic-added", topic });
      return this.provision(topic.id, this.requestKey(clientId, requestId), new Set(), clientId);
    });
  }

  retry(clientId: string, requestId: string, topicId: string): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `retry:${topicId}`, async () => {
      const topic = await this.options.topics.load(topicId);
      if (topic.setup.state !== "setup-failed" && topic.setup.state !== "provisioning") {
        throw new WorkDataError(
          "invalid-topic-state",
          "Only unfinished Topic setup can be retried.",
        );
      }
      this.topicById.set(topic.id, topic);
      this.requireConfigured();
      return this.provision(topic.id, this.requestKey(clientId, requestId), new Set(), clientId);
    });
  }

  rename(
    clientId: string,
    requestId: string,
    topicId: string,
    name: string,
  ): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `rename:${topicId}:${name}`, () =>
      this.serializeTopic(topicId, async () => {
        const trimmed = name.trim();
        if (trimmed.length === 0) {
          throw new WorkDataError("invalid-topic", "Topic name must not be empty.");
        }
        const topic = await this.options.topics.update(topicId, (current) => ({
          ...current,
          name: trimmed,
        }));
        this.topicById.set(topic.id, topic);
        this.emit({ type: "topic-changed", topic });
        return { status: "renamed", topic };
      }),
    ) as Promise<TopicMutationResult>;
  }

  delete(clientId: string, requestId: string, topicId: string): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `delete:${topicId}`, () =>
      this.requestDeletion(topicId, clientId, this.requestKey(clientId, requestId)),
    ) as Promise<TopicMutationResult>;
  }

  accessWorkspace(
    clientId: string,
    requestId: string,
    topicId: string,
  ): Promise<WorkspaceActionResult> {
    return this.deduplicate(clientId, requestId, `workspace:${topicId}`, () =>
      this.serializeTopic(topicId, async () => {
        const topic = await this.options.topics.load(topicId);
        this.setOperation({ topicId, kind: "access-workspace", state: "running" });
        try {
          const result = await this.requireDesktop().accessWorkspace(topic.id);
          this.emit({ type: "workspace-accessed", topicId, result });
          return result;
        } finally {
          this.clearOperation(topicId);
        }
      }),
    ) as Promise<WorkspaceActionResult>;
  }

  openTerminal(clientId: string, requestId: string, topicId: string): Promise<WorkActionResult> {
    return this.deduplicate(clientId, requestId, `terminal:${topicId}`, () =>
      this.serializeTopic(topicId, () =>
        this.openTerminalSerial(topicId, clientId, this.requestKey(clientId, requestId), false),
      ),
    );
  }

  openMainAgent(clientId: string, requestId: string, topicId: string): Promise<WorkActionResult> {
    return this.deduplicate(clientId, requestId, `agent:${topicId}`, () =>
      this.serializeTopic(topicId, () =>
        this.openMainAgentSerial(topicId, clientId, this.requestKey(clientId, requestId), false),
      ),
    );
  }

  resetMainAgent(clientId: string, requestId: string, topicId: string): Promise<WorkActionResult> {
    return this.deduplicate(clientId, requestId, `agent-reset:${topicId}`, () =>
      this.serializeTopic(topicId, () =>
        this.resetMainAgentSerial(topicId, clientId, this.requestKey(clientId, requestId), false),
      ),
    );
  }

  openPullRequest(
    clientId: string,
    requestId: string,
    topicId: string,
  ): Promise<PullRequestActionResult> {
    return this.deduplicate(clientId, requestId, `pull-request:${topicId}`, async () => {
      await this.options.topics.load(topicId);
      const pullRequest = this.pullRequestById.get(topicId);
      if (pullRequest === undefined) {
        return { kind: "unavailable", message: "This Topic has no known pull request." };
      }
      if (this.options.desktop?.openPullRequest === undefined) {
        return { kind: "unavailable", message: "Pull request browser control is not available." };
      }
      return this.options.desktop.openPullRequest(pullRequest.url);
    }) as Promise<PullRequestActionResult>;
  }

  confirm<T extends WorkActionResult = TopicMutationResult>(
    clientId: string,
    requestId: string,
    token: string,
  ): Promise<T> {
    return this.deduplicate(clientId, requestId, `confirm:${token}`, async () => {
      const pending = this.takeConfirmation(token, clientId);
      this.config = await this.options.config.load();
      this.requireConfig();
      if (pending.operation === "delete") {
        return this.serializeTopic(pending.topicId, () =>
          this.performDeletion(pending.topicId, "ask"),
        );
      }
      if (pending.operation === "terminal") {
        return this.serializeTopic(pending.topicId, () =>
          this.openTerminalSerial(pending.topicId, pending.clientId, pending.originalRequest, true),
        );
      }
      if (pending.operation === "agent") {
        return this.serializeTopic(pending.topicId, () =>
          this.openMainAgentSerial(
            pending.topicId,
            pending.clientId,
            pending.originalRequest,
            true,
          ),
        );
      }
      if (pending.operation === "reset-agent") {
        return this.serializeTopic(pending.topicId, () =>
          this.resetMainAgentSerial(
            pending.topicId,
            pending.clientId,
            pending.originalRequest,
            true,
          ),
        );
      }
      const approved = new Set(pending.approvedActions);
      approved.add(pending.action);
      return this.provision(pending.topicId, pending.originalRequest, approved, pending.clientId);
    }) as Promise<T>;
  }

  reject(clientId: string, requestId: string, token: string): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `reject:${token}`, async () => {
      const pending = this.takeConfirmation(token, clientId);
      return this.serializeTopic(pending.topicId, async () => {
        this.clearOperation(pending.topicId);
        if (pending.operation === "provision") {
          const topic = await this.options.topics.update(pending.topicId, (current) => ({
            ...current,
            setup: {
              ...current.setup,
              state: "setup-failed",
              reason: "Confirmation was rejected.",
            },
          }));
          this.topicById.set(topic.id, topic);
          this.emit({ type: "setup-changed", topic });
          this.emit({ type: "topic-changed", topic });
        }
        return { status: "rejected", topicId: pending.topicId };
      });
    });
  }

  private async openTerminalSerial(
    topicId: string,
    clientId: string,
    originalRequest: string,
    approved: boolean,
  ): Promise<WorkActionResult> {
    const topic = await this.options.topics.load(topicId);
    requireReadyWorktree(topic);
    const policy = resolveActionPolicy(this.requireConfig().policies, "terminal.open", {
      topicId,
      repository: topic.repository,
    });
    if (policy.policy === "deny") {
      return { status: "denied", reason: "Policy denied terminal.open.", topic };
    }
    if (policy.policy === "ask" && !approved) {
      return this.requireConfirmation({
        clientId,
        originalRequest,
        topicId,
        action: "terminal.open",
        operation: "terminal",
        approvedActions: new Set(),
        text: `Open a terminal for Topic ${topic.name}?`,
      });
    }
    this.setOperation({ topicId, kind: "open-terminal", state: "running" });
    try {
      const result = await this.requireDesktop().openTerminal(topic.id, topic.worktreePath!);
      this.emit({ type: "terminal-opened", topicId, result });
      return result;
    } finally {
      this.clearOperation(topicId);
    }
  }

  private async openMainAgentSerial(
    topicId: string,
    clientId: string,
    originalRequest: string,
    approved: boolean,
  ): Promise<WorkActionResult> {
    const topic = await this.options.topics.load(topicId);
    requireReadyWorktree(topic);
    const policy = resolveActionPolicy(this.requireConfig().policies, "agent.open", {
      topicId,
      repository: topic.repository,
    });
    if (policy.policy === "deny") {
      return { status: "denied", reason: "Policy denied agent.open.", topic };
    }
    if (policy.policy === "ask" && !approved) {
      return this.requireConfirmation({
        clientId,
        originalRequest,
        topicId,
        action: "agent.open",
        operation: "agent",
        approvedActions: new Set(),
        text: `Open the Main Agent for Topic ${topic.name}?`,
      });
    }
    if (this.options.mainAgent === undefined) {
      throw new WorkDataError("unavailable", "Main Agent control is not available.");
    }
    this.setOperation({ topicId, kind: "open-agent", state: "running" });
    try {
      const result = await this.options.mainAgent.open(topic);
      this.emit({ type: "main-agent-opened", topicId, result });
      return result;
    } finally {
      this.clearOperation(topicId);
    }
  }

  private async resetMainAgentSerial(
    topicId: string,
    clientId: string,
    originalRequest: string,
    approved: boolean,
  ): Promise<WorkActionResult> {
    const topic = await this.options.topics.load(topicId);
    requireReadyWorktree(topic);
    const policy = resolveActionPolicy(this.requireConfig().policies, "agent.reset", {
      topicId,
      repository: topic.repository,
    });
    if (policy.policy === "deny") {
      return { status: "denied", reason: "Policy denied agent.reset.", topic };
    }
    if (policy.policy === "ask" && !approved) {
      return this.requireConfirmation({
        clientId,
        originalRequest,
        topicId,
        action: "agent.reset",
        operation: "reset-agent",
        approvedActions: new Set(),
        text: `Close the current Main Agent for Topic ${topic.name} and start a new empty session? The previous session file will be kept.`,
      });
    }
    if (this.options.mainAgent === undefined) {
      throw new WorkDataError("unavailable", "Main Agent control is not available.");
    }
    this.setOperation({ topicId, kind: "reset-agent", state: "running" });
    try {
      const result = await this.options.mainAgent.reset(topic);
      await this.refreshTopic(topicId);
      this.emit({ type: "main-agent-opened", topicId, result });
      return result;
    } finally {
      this.clearOperation(topicId);
    }
  }

  private provision(
    topicId: string,
    originalRequest: string,
    approvedActions: ReadonlySet<ActionId>,
    clientId: string,
  ): Promise<TopicMutationResult> {
    return this.serializeTopic(topicId, () =>
      this.provisionSerial(topicId, originalRequest, approvedActions, clientId),
    );
  }

  private async provisionSerial(
    topicId: string,
    originalRequest: string,
    approvedActions: ReadonlySet<ActionId>,
    clientId: string,
  ): Promise<TopicMutationResult> {
    const config = this.requireConfigured();
    this.setOperation({ topicId, kind: "provision", state: "running" });
    const repository = this.topicById.get(topicId)?.repository;
    const recipe =
      repository === undefined ? [] : (config.repositories[repository]?.setupCommands ?? []);
    const request: ProvisionRequest = {
      topicId,
      workBase: config.workBase!,
      policies: config.policies,
      recipe,
      approvedActions,
      onSetupProgress: (progress) =>
        this.setOperation({
          topicId,
          kind: "provision",
          state: "running",
          detail: `setup ${progress.index + 1}/${progress.total}`,
        }),
    };
    let result: ProvisionResult;
    try {
      result = await this.options.provisioner.provision(request);
    } catch (error) {
      this.clearOperation(topicId);
      throw error;
    }
    this.topicById.set(result.topic.id, result.topic);
    this.emit({ type: "setup-changed", topic: result.topic });
    this.emit({ type: "topic-changed", topic: result.topic });

    if (result.status === "confirmation-required") {
      if (originalRequest === "startup") {
        const topic = await this.options.topics.update(topicId, (current) => ({
          ...current,
          setup: {
            ...current.setup,
            state: "setup-failed",
            reason: "Confirmation is required. Retry Topic setup.",
          },
        }));
        this.topicById.set(topic.id, topic);
        this.emit({ type: "setup-changed", topic });
        this.emit({ type: "topic-changed", topic });
        this.clearOperation(topicId);
        return { status: "failed", reason: topic.setup.reason!, topic };
      }
      return this.requireConfirmation({
        clientId,
        originalRequest,
        topicId,
        action: result.action,
        operation: "provision",
        approvedActions,
        text: `Allow ${result.action} for Topic ${result.topic.name}?`,
      });
    }
    this.clearOperation(topicId);
    void this.refreshPullRequest(topicId);
    return provisionResult(result);
  }

  private requestDeletion(
    topicId: string,
    clientId: string,
    originalRequest: string,
  ): Promise<TopicMutationResult> {
    return this.serializeTopic(topicId, () =>
      this.requestDeletionSerial(topicId, clientId, originalRequest),
    );
  }

  private async requestDeletionSerial(
    topicId: string,
    clientId: string,
    originalRequest: string,
  ): Promise<TopicMutationResult> {
    const topic = await this.options.topics.load(topicId);
    const policy = resolveActionPolicy(this.requireConfig().policies, "topic.delete", {
      topicId,
      repository: topic.repository,
    });
    if (policy.policy === "deny") {
      return { status: "denied", reason: "Policy denied topic.delete.", topic };
    }
    return this.requireConfirmation({
      clientId,
      originalRequest,
      topicId,
      action: "topic.delete",
      operation: "delete",
      approvedActions: new Set(),
      text: "Delete only this local Topic record? The branch, worktree, base checkout, Pi session, and open windows will remain and will not be deleted.",
    });
  }

  private async performDeletion(
    topicId: string,
    approvedPolicy: "allow" | "ask",
  ): Promise<TopicMutationResult> {
    const topic = await this.options.topics.load(topicId);
    const policy = resolveActionPolicy(this.requireConfig().policies, "topic.delete", {
      topicId,
      repository: topic.repository,
    });
    if (policy.policy === "deny" || (policy.policy === "ask" && approvedPolicy !== "ask")) {
      return { status: "denied", reason: "Policy denied topic.delete.", topic };
    }
    this.setOperation({ topicId, kind: "delete", state: "running" });
    try {
      await this.options.topics.delete(topicId);
    } catch (error) {
      this.clearOperation(topicId);
      throw error;
    }
    this.clearOperation(topicId);
    this.topicById.delete(topicId);
    if (this.pullRequestById.delete(topicId)) {
      this.emit({ type: "pull-request-changed", topicId, pullRequest: null });
    }
    this.emit({ type: "topic-removed", topicId });
    return { status: "deleted", topicId };
  }

  private requireConfirmation(
    input: Omit<PendingConfirmation, "token" | "expiresAtMs"> & { text: string },
  ): ConfirmationRequirement {
    const token = this.generateToken();
    const expiresAtMs = this.now().getTime() + this.confirmationTtlMs;
    const { text, ...pending } = input;
    this.confirmations.set(token, { ...pending, token, expiresAtMs });
    this.setOperation({
      topicId: input.topicId,
      kind:
        input.operation === "terminal"
          ? "open-terminal"
          : input.operation === "agent"
            ? "open-agent"
            : input.operation,
      state: "confirmation-required",
    });
    return {
      status: "confirmation-required",
      token,
      action: input.action,
      topicId: input.topicId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      text: boundMessage(text),
    };
  }

  private takeConfirmation(token: string, clientId: string): PendingConfirmation {
    const pending = this.confirmations.get(token);
    if (pending === undefined || pending.clientId !== clientId) {
      throw new WorkDataError("invalid-confirmation", "Confirmation token is invalid.");
    }
    this.confirmations.delete(token);
    if (this.now().getTime() >= pending.expiresAtMs) {
      this.clearOperation(pending.topicId);
      throw new WorkDataError("expired-confirmation", "Confirmation token has expired.");
    }
    return pending;
  }

  private requireDesktop(): DesktopController {
    if (this.options.desktop === undefined) {
      throw new WorkDataError("unavailable", "Desktop control is not available.");
    }
    return this.options.desktop;
  }

  private requireConfig(): WorkConfig {
    if (this.config === null) {
      throw new WorkDataError("missing-config", "Work configuration does not exist.");
    }
    return this.config;
  }

  private requireConfigured(): WorkConfig & { workBase: string } {
    const config = this.requireConfig();
    if (config.workBase === undefined) {
      throw new WorkDataError("missing-work-base", "Work configuration has no workBase.");
    }
    return config as WorkConfig & { workBase: string };
  }

  private setOperation(operation: TopicOperation): void {
    this.operations.set(operation.topicId, operation);
    this.emit({ type: "operation-changed", topicId: operation.topicId, operation });
  }

  private clearOperation(topicId: string): void {
    this.operations.delete(topicId);
    this.emit({ type: "operation-changed", topicId, operation: null });
  }

  private async serializeTopic<T>(topicId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.topicQueues.get(topicId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.topicQueues.set(topicId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.topicQueues.get(topicId) === current) this.topicQueues.delete(topicId);
    }
  }

  private emit(event: TopicServiceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private deduplicate<T extends WorkActionResult>(
    clientId: string,
    requestId: string,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.requestKey(clientId, requestId);
    const existing = this.deduplicated.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new WorkDataError(
            "request-id-conflict",
            "Request id was already used with different arguments.",
          ),
        );
      }
      return existing.result as Promise<T>;
    }
    const pending = operation();
    this.deduplicated.set(key, { fingerprint, result: pending });
    if (this.deduplicated.size > MAX_DEDUPLICATED_REQUESTS) {
      const oldest = this.deduplicated.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== key) this.deduplicated.delete(oldest);
    }
    return pending;
  }

  private requestKey(clientId: string, requestId: string): string {
    return JSON.stringify([clientId, requestId]);
  }
}

function requireReadyWorktree(topic: TopicManifest): void {
  if (topic.setup.state !== "ready") {
    throw new WorkDataError("invalid-topic-state", "Topic setup is not ready.");
  }
  if (topic.worktreePath === null || !isAbsolute(topic.worktreePath)) {
    throw new WorkDataError("invalid-worktree", "Topic worktree path is not valid.");
  }
}

function deniedTopicActions(config: WorkConfig | null, topic: TopicManifest): ActionId[] {
  if (config === null) return [];
  const subject = { topicId: topic.id, repository: topic.repository };
  const candidates: ActionId[] = ["terminal.open", "agent.open", "agent.reset", "topic.delete"];
  if (!topic.setup.repositoryAvailable) candidates.push("repository.clone");
  if (!topic.setup.worktreeCreated) candidates.push("topic.create-worktree");
  return candidates.filter(
    (action) => resolveActionPolicy(config.policies, action, subject).policy === "deny",
  );
}

function provisionResult(result: ProvisionResult): TopicMutationResult {
  if (result.status === "ready") return result;
  if (result.status === "confirmation-required") {
    throw new Error("Confirmation result must be handled by Topic Service.");
  }
  return result;
}

function samePullRequest(left: PullRequestRef | null, right: PullRequestRef | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.number === right.number &&
    left.url === right.url &&
    left.state === right.state &&
    left.draft === right.draft &&
    left.ci === right.ci &&
    left.reviewPending === right.reviewPending &&
    left.changesRequested === right.changesRequested &&
    left.approved === right.approved &&
    left.unresolvedThreads === right.unresolvedThreads
  );
}

/** Splits a validated owner/name Topic repository into pull request target fields. */
function prTarget(repository: string): { owner: string; repo: string } {
  const reference = parseRepository(repository);
  return { owner: reference.owner, repo: reference.name };
}
