import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  WorkDataError,
  boundMessage,
  defaultBranchForTopicName,
  generateTopicId,
  isTopicId,
  isValidBranchName,
  normalizeTopicNote,
  parseRepository,
  chainNodeKey,
  detectLegacyFamilies,
  planLegacyMigration,
  planChainMove,
  planChangeParent,
  planChildActivation,
  planChildInsertion,
  planIntegrationTargetReset,
  planRemoveParent,
  planTopicDeletion,
  topicNode,
  INTEGRATION_BRANCH_NODE,
  resolveActionPolicy,
  resolveBaseCheckout,
  resolveIntegrationBranch,
} from "../shared/index.ts";
import type {
  ActionId,
  ChainNode,
  ChainPlan,
  ChainEdit,
  ChainResult,
  ChainTopic,
  AncestryLookup,
  LegacyMigrationPreview,
  LegacyMigrationSkip,
  LegacyNameFamily,
  LegacyTopic,
  ConfirmableActionId,
  ChildTopicCreationRequest,
  ConfigStore,
  IntegrationTarget,
  PullRequestRef,
  TopicCreationRequest,
  TopicDiagnostic,
  TopicManifest,
  TopicStartPoint,
  TopicStore,
  WorkConfig,
} from "../shared/index.ts";
import type { AncestryRef, BranchAncestryReader } from "./branch-ancestry.ts";
import { migrationWrites } from "./legacy-migration.ts";
import type { LegacyMigrationJournal } from "./legacy-migration.ts";
import type {
  DesktopController,
  MainAgentActionResult,
  PullRequestActionResult,
  TerminalActionResult,
  WorkspaceActionResult,
} from "./desktop.ts";
import type { MainAgentManager } from "./main-agent.ts";
import type { IntegrationBranchResolver } from "./integration-branch.ts";
import { unknownIntegrationStatus } from "./integration-status.ts";
import type { IntegrationStatus, IntegrationStatusObserver } from "./integration-status.ts";
import type { PullRequestObserver } from "./pull-request-observer.ts";
import type { ProvisionRequest, ProvisionResult, TopicProvisioner } from "./provisioner.ts";

const CONFIRMATION_TTL_MS = 60_000;
const MAX_DEDUPLICATED_REQUESTS = 1_000;
const PULL_REQUEST_POLL_INTERVAL_MS = 60_000;
const WORKTREE_POLL_INTERVAL_MS = 2_000;
const MAX_DIAGNOSTICS = 100;
/** Diagnostic code of a ready child Topic that is still outside the active chain. */
const PENDING_CHAIN_CODE = "chain-pending";

export interface TopicOperation {
  topicId: string;
  kind:
    | "provision"
    | "delete"
    | "access-workspace"
    | "open-terminal"
    | "open-agent"
    | "reset-agent"
    | "change-chain";
  state: "running" | "confirmation-required";
  /** Live sub-step, for example a `setup N/M` Repository Recipe phase. */
  detail?: string;
}

export interface TopicServiceSnapshot {
  topics: readonly TopicManifest[];
  diagnostics: readonly TopicDiagnostic[];
  operations: readonly TopicOperation[];
  /** Sorted `owner/repo` keys declared in config, offered as add-topic completions. */
  knownRepositories: readonly string[];
  baseCheckouts: Readonly<Record<string, string>>;
  /** Configured Integration Branch per `owner/repo`, absent while none is inferred yet. */
  integrationBranches: Readonly<Record<string, string>>;
  /** Observed Integration Status per Topic id. */
  integrationStatuses: Readonly<Record<string, IntegrationStatus>>;
  deniedActions: Readonly<Record<string, readonly ActionId[]>>;
  pullRequests: Readonly<Record<string, PullRequestRef>>;
  /** Ready Topics whose recorded Worktree path is not an existing directory. */
  orphanedTopicIds: readonly string[];
  /** Unresolved legacy ` > ` name families detected by name only, without any write. */
  legacyFamilies: number;
}

export type TopicServiceEvent =
  | { type: "topic-added"; topic: TopicManifest }
  | { type: "setup-changed"; topic: TopicManifest }
  | { type: "topic-changed"; topic: TopicManifest }
  | { type: "topic-removed"; topicId: string }
  | { type: "diagnostic-added"; diagnostic: TopicDiagnostic }
  | { type: "diagnostic-cleared"; topicId: string; code: string }
  | { type: "workspace-accessed"; topicId: string; result: WorkspaceActionResult }
  | { type: "terminal-opened"; topicId: string; result: TerminalActionResult }
  | { type: "main-agent-opened"; topicId: string; result: MainAgentActionResult }
  | { type: "pull-request-changed"; topicId: string; pullRequest: PullRequestRef | null }
  | { type: "worktree-presence-changed"; topicId: string; orphaned: boolean }
  | { type: "integration-status-changed"; topicId: string; status: IntegrationStatus }
  | { type: "operation-changed"; topicId: string; operation: TopicOperation | null };

export interface ConfirmationRequirement {
  status: "confirmation-required";
  token: string;
  action: ConfirmableActionId;
  topicId: string;
  expiresAt: string;
  text: string;
}

export type TopicMutationResult =
  | { status: "ready"; topic: TopicManifest }
  | { status: "renamed"; topic: TopicManifest }
  | { status: "note-updated"; topic: TopicManifest }
  | { status: "refocused"; topic: TopicManifest }
  | { status: "chain-changed"; topic: TopicManifest }
  | { status: "deleted"; topicId: string }
  | { status: "rejected"; topicId: string }
  | {
      status: "denied" | "failed" | "timeout" | "cancelled";
      code?: string;
      reason: string;
      topic: TopicManifest;
    }
  | ConfirmationRequirement;

export type WorkActionResult =
  | TopicMutationResult
  | LegacyMigrationPreviewResult
  | LegacyMigrationApplyResult
  | WorkspaceActionResult
  | TerminalActionResult
  | MainAgentActionResult
  | PullRequestActionResult;

/** The read-only result of one legacy migration preview. It proves that nothing changed. */
export interface LegacyMigrationPreviewResult {
  status: "migration-preview";
  preview: LegacyMigrationPreview;
}

/** The result of one approved legacy migration run. */
export interface LegacyMigrationApplyResult {
  status: "migration-applied";
  /** The recovery journal id of this run, or null when no family was written. */
  migrationId: string | null;
  appliedParentTopicIds: readonly string[];
  /** Families that a write failure restored from their pre-migration backups. */
  rolledBackParentTopicIds: readonly string[];
  skipped: readonly LegacyMigrationSkip[];
}

/**
 * One safe Integration Chain maintenance request. It only rewires durable links; it never
 * runs fetch, pull, rebase, merge, reset, cherry-pick, or any Branch movement.
 */
export type ChainMaintenanceAction =
  /** Move one Topic into another family, at the position that current ancestry gives. */
  | { kind: "change-parent"; topicId: string; newParentTopicId: string }
  /** Make one child a root Topic again, against the repository Integration Branch. */
  | { kind: "remove-parent"; topicId: string }
  /** Move one child to an explicit place in its own Integration Chain. */
  | { kind: "move"; topicId: string; target: IntegrationTarget }
  /** Rebuild one family's Integration Chain from current Git ancestry. */
  | { kind: "reset"; topicId: string };

interface PendingConfirmation {
  token: string;
  clientId: string;
  originalRequest: string;
  topicId: string;
  action: ConfirmableActionId;
  expiresAtMs: number;
  operation: "provision" | "delete" | "terminal" | "agent" | "reset-agent" | "chain";
  approvedActions: ReadonlySet<ActionId>;
  startPoint?: TopicCreationRequest["startPoint"];
  /** The prepared chain maintenance action of a `chain` confirmation. */
  chainAction?: ChainMaintenanceAction;
}

export interface TopicServiceOptions {
  config: ConfigStore;
  topics: TopicStore;
  provisioner: Pick<TopicProvisioner, "provision">;
  desktop?: DesktopController;
  mainAgent?: MainAgentManager;
  pullRequests?: PullRequestObserver;
  /** Infers and persists a missing repository Integration Branch. */
  integrationBranches?: IntegrationBranchResolver;
  /** Observes local Integration Status from committed Branch tips. */
  integrationStatuses?: IntegrationStatusObserver;
  /** Answers committed Git ancestry questions for Integration Chain placement. */
  ancestry?: BranchAncestryReader;
  /** Owns pre-migration manifest backups and the durable legacy migration journal. */
  migrations?: LegacyMigrationJournal;
  now?: () => Date;
  confirmationTtlMs?: number;
  generateToken?: () => string;
  pullRequestPollIntervalMs?: number;
  worktreePollIntervalMs?: number;
  stat?: typeof stat;
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
  private readonly orphanedTopicIds = new Set<string>();
  private readonly integrationStatusById = new Map<string, IntegrationStatus>();
  private pullRequestTimer: ReturnType<typeof setInterval> | undefined;
  private worktreeTimer: ReturnType<typeof setInterval> | undefined;
  private readonly topicQueues = new Map<string, Promise<void>>();
  private readonly creationQueues = new Map<string, Promise<void>>();
  private readonly chainQueues = new Map<string, Promise<void>>();
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
  private readonly worktreePollIntervalMs: number;

  constructor(options: TopicServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.confirmationTtlMs = options.confirmationTtlMs ?? CONFIRMATION_TTL_MS;
    this.generateToken = options.generateToken ?? randomUUID;
    this.pullRequestPollIntervalMs =
      options.pullRequestPollIntervalMs ?? PULL_REQUEST_POLL_INTERVAL_MS;
    this.worktreePollIntervalMs = options.worktreePollIntervalMs ?? WORKTREE_POLL_INTERVAL_MS;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // An interrupted legacy migration settles before any Topic is published, so the daemon
    // never serves a half-written family. Recovery only restores manifest backups.
    await this.recoverLegacyMigration();
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
    await this.refreshWorktreePresence();
    await this.refreshIntegrationBranches();
    await this.refreshIntegrationStatuses();
    if (this.worktreeTimer === undefined) {
      const start = this.options.setInterval ?? globalThis.setInterval;
      this.worktreeTimer = start(() => {
        void this.refreshWorktreePresence();
      }, this.worktreePollIntervalMs);
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
    if (this.worktreeTimer !== undefined) {
      (this.options.clearInterval ?? globalThis.clearInterval)(this.worktreeTimer);
      this.worktreeTimer = undefined;
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
      knownRepositories:
        this.config === null ? [] : Object.keys(this.config.repositories).toSorted(),
      baseCheckouts: Object.fromEntries(
        [...this.topicById.values()].map((topic) => [
          topic.id,
          this.config === null
            ? "not configured"
            : (resolveBaseCheckout(this.config, topic.repository) ?? "not configured"),
        ]),
      ),
      integrationBranches: integrationBranchMap(this.config),
      integrationStatuses: Object.fromEntries(this.integrationStatusById),
      deniedActions: Object.fromEntries(
        [...this.topicById.values()].map((topic) => [
          topic.id,
          deniedTopicActions(this.config, topic),
        ]),
      ),
      pullRequests: Object.fromEntries(this.pullRequestById),
      orphanedTopicIds: [...this.orphanedTopicIds].toSorted(),
      legacyFamilies: detectLegacyFamilies(this.legacyTopics()).families.length,
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
    await this.refreshTopicWorktreePresence(topic);
    return topic;
  }

  /** Forces an immediate re-poll of every Topic's pull request, outside the timer cadence. */
  async refreshPullRequests(): Promise<void> {
    await this.refreshAllPullRequests();
  }

  /** Re-checks recorded Worktree paths immediately, outside the poll cadence. */
  async refreshWorktreePresence(): Promise<void> {
    await Promise.all(
      [...this.topicById.values()].map((topic) => this.refreshTopicWorktreePresence(topic)),
    );
  }

  /**
   * Infers and persists a missing Integration Branch for every repository that has a Topic,
   * then reloads configuration so snapshots show the stored value.
   */
  async refreshIntegrationBranches(): Promise<void> {
    const resolver = this.options.integrationBranches;
    if (resolver === undefined) return;
    await resolver.ensureAll([...this.topicById.values()].map((topic) => topic.repository));
    this.config = await this.options.config.load();
  }

  /**
   * Re-observes the Integration Status of every Topic from committed local Branch tips.
   * Callers drive it from daemon start, dashboard refresh, and chain changes; it adds no
   * timer and no watcher, and one Topic failure only makes that Topic Unknown.
   */
  async refreshIntegrationStatuses(): Promise<void> {
    const observer = this.options.integrationStatuses;
    if (observer === undefined) return;
    for (const topicId of Array.from(this.integrationStatusById.keys())) {
      if (!this.topicById.has(topicId)) this.integrationStatusById.delete(topicId);
    }
    for (const topic of Array.from(this.topicById.values())) {
      const status = await this.observeIntegrationStatus(observer, topic);
      if (sameIntegrationStatus(this.integrationStatusById.get(topic.id), status)) continue;
      this.integrationStatusById.set(topic.id, status);
      this.emit({ type: "integration-status-changed", topicId: topic.id, status });
    }
  }

  private async observeIntegrationStatus(
    observer: IntegrationStatusObserver,
    topic: TopicManifest,
  ): Promise<IntegrationStatus> {
    if (topic.setup.state !== "ready") {
      return unknownIntegrationStatus("Topic setup is not finished.");
    }
    if (topic.chainState === "pending") {
      return unknownIntegrationStatus("Insertion into the Integration Chain is still pending.");
    }
    if (this.orphanedTopicIds.has(topic.id)) {
      return unknownIntegrationStatus("The recorded Worktree of this Topic is missing.");
    }
    const repositoryPath =
      this.config === null ? undefined : resolveBaseCheckout(this.config, topic.repository);
    if (repositoryPath === undefined) {
      return unknownIntegrationStatus("The repository of this Topic has no Base checkout.");
    }
    const target = this.integrationTargetBranch(topic);
    if ("unknown" in target) return target.unknown;
    return observer.observe({
      repositoryPath,
      branch: topic.branch,
      targetBranch: target.branch,
    });
  }

  /**
   * The local Branch that this Topic must contain, or the Unknown status that explains why
   * no Branch can be resolved. Origin Commits never take part in this resolution.
   */
  private integrationTargetBranch(
    topic: TopicManifest,
  ): { branch: string } | { unknown: IntegrationStatus } {
    const target = topic.integrationTarget ?? this.defaultIntegrationTarget(topic);
    if (target === undefined) {
      return { unknown: unknownIntegrationStatus("This Topic has no Integration Target yet.") };
    }
    if (target.kind === "integration-branch") {
      const branch =
        this.config === null ? undefined : resolveIntegrationBranch(this.config, topic.repository);
      return branch === undefined
        ? { unknown: unknownIntegrationStatus("The repository has no Integration Branch yet.") }
        : { branch };
    }
    const targetTopic = this.topicById.get(target.topicId);
    if (targetTopic === undefined || targetTopic.repository !== topic.repository) {
      return { unknown: unknownIntegrationStatus("The Integration Target Topic is missing.") };
    }
    if (targetTopic.setup.state !== "ready" || targetTopic.chainState === "pending") {
      return { unknown: unknownIntegrationStatus("The Integration Target Topic is not ready.") };
    }
    return { branch: targetTopic.branch };
  }

  /** A root Topic without active children integrates into the repository Integration Branch. */
  private defaultIntegrationTarget(topic: TopicManifest): IntegrationTarget | undefined {
    if (topic.parentTopicId !== undefined) return undefined;
    const hasActiveChild = [...this.topicById.values()].some(
      (candidate) => candidate.parentTopicId === topic.id && candidate.chainState !== "pending",
    );
    return hasActiveChild ? undefined : { kind: "integration-branch" };
  }

  private async refreshTopicWorktreePresence(topic: TopicManifest): Promise<void> {
    const wasOrphaned = this.orphanedTopicIds.has(topic.id);
    const orphaned =
      topic.setup.state === "ready" &&
      topic.worktreePath !== null &&
      !(await isDirectory(topic.worktreePath, this.options.stat ?? stat));
    if (orphaned === wasOrphaned) return;
    if (orphaned) this.orphanedTopicIds.add(topic.id);
    else this.orphanedTopicIds.delete(topic.id);
    this.emit({ type: "worktree-presence-changed", topicId: topic.id, orphaned });
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
    const current = this.pullRequestById.get(topicId) ?? null;
    const next =
      topic === undefined || topic.setup.state !== "ready" || worktreePath === null
        ? null
        : await observer
            .discover({
              ...prTarget(topic.repository),
              branch: topic.branch,
              worktreePath,
              ...(current === null ? {} : { knownPullRequestNumber: current.number }),
            })
            .catch(() => null);
    if (samePullRequest(current, next)) return;
    if (next === null) this.pullRequestById.delete(topicId);
    else this.pullRequestById.set(topicId, next);
    this.emit({ type: "pull-request-changed", topicId, pullRequest: next });
  }

  create(
    clientId: string,
    requestId: string,
    input: TopicCreationRequest,
  ): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `create:${JSON.stringify(input)}`, async () => {
      validateCreationRequest(input);
      // Re-read config from disk so a manually edited Repository Recipe applies to a new Topic.
      this.config = await this.options.config.load();
      this.requireConfigured();
      const topic = await this.serializeCreation(input.repository, input.branch, async () => {
        const existing = [...this.topicById.values()].find(
          (candidate) =>
            candidate.repository === input.repository && candidate.branch === input.branch,
        );
        if (existing !== undefined) {
          throw new WorkDataError(
            "topic-branch-conflict",
            "A Topic with this repository and Branch already exists.",
            { existingTopicId: existing.id, existingTopicName: existing.name },
          );
        }
        const created = await this.options.topics.create({
          name: input.name,
          branch: input.branch,
          repository: input.repository,
        });
        this.topicById.set(created.id, created);
        this.emit({ type: "topic-added", topic: created });
        return created;
      });
      // The first Topic of a repository makes its Integration Branch resolvable at once, so
      // the new Topic does not read Unknown until the next explicit refresh.
      await this.refreshIntegrationBranches();
      try {
        return await this.provision(
          topic.id,
          this.requestKey(clientId, requestId),
          new Set(),
          clientId,
          input.startPoint,
        );
      } catch (error) {
        if (input.startPoint !== undefined) await this.refreshTopic(topic.id);
        throw error;
      }
    });
  }

  /**
   * Creates one child Topic at an exact commit of its Parent Topic Branch. The child is
   * stored with its Parent Topic, Origin Commit, intended Integration Target, and pending
   * chain state before provisioning starts, so the healthy chain of the family never
   * depends on a running setup. Provisioning follows the normal Topic path, and successful
   * setup activates the insertion under the family's chain lock.
   */
  createChild(
    clientId: string,
    requestId: string,
    input: ChildTopicCreationRequest,
  ): Promise<TopicMutationResult> {
    const fingerprint = `create-child:${JSON.stringify(input)}`;
    return this.deduplicate(clientId, requestId, fingerprint, async () => {
      const request = validateChildCreationRequest(input);
      // Re-read config from disk so a manually edited Repository Recipe applies to a new Topic.
      this.config = await this.options.config.load();
      this.requireConfigured();
      const topic = await this.serializeChain(request.parentTopicId, () =>
        this.createPendingChild(request),
      );
      try {
        return await this.provision(
          topic.id,
          this.requestKey(clientId, requestId),
          new Set(),
          clientId,
          request.startPoint,
        );
      } catch (error) {
        await this.refreshTopic(topic.id);
        throw error;
      }
    });
  }

  /** Validates the family rules and stores the pending child, without any chain rewiring. */
  private async createPendingChild(request: ChildRequest): Promise<TopicManifest> {
    const parent = await this.options.topics.load(request.parentTopicId);
    this.topicById.set(parent.id, parent);
    if (parent.parentTopicId !== undefined) {
      throw new WorkDataError("nested-child", "A child Topic cannot have children.");
    }
    if (parent.setup.state !== "ready") {
      throw new WorkDataError("invalid-topic-state", "The Parent Topic setup is not finished.");
    }
    const repositoryPath = resolveBaseCheckout(this.requireConfig(), parent.repository);
    if (repositoryPath === undefined) {
      throw new WorkDataError(
        "missing-base-checkout",
        "The repository of the Parent Topic has no Base checkout.",
      );
    }
    const originCommit = request.startPoint.commit.toLowerCase();
    const contained = await this.ancestryReader().contains({
      repositoryPath,
      ancestor: { commit: originCommit },
      descendant: { branch: parent.branch },
    });
    if (contained !== true) {
      throw new WorkDataError(
        "invalid-start-point",
        "The Start Point is not a commit of the Parent Topic Branch.",
      );
    }
    const existing = [...this.topicById.values()].find(
      (candidate) =>
        candidate.repository === parent.repository && candidate.branch === request.branch,
    );
    if (existing !== undefined) {
      throw new WorkDataError(
        "topic-branch-conflict",
        "A Topic with this repository and Branch already exists.",
        { existingTopicId: existing.id, existingTopicName: existing.name },
      );
    }
    const integrationTarget = await this.planPendingPlacement(parent, originCommit, repositoryPath);
    const created = await this.options.topics.create(
      { name: request.name, branch: request.branch, repository: parent.repository },
      { parentTopicId: parent.id, originCommit, integrationTarget, chainState: "pending" },
    );
    this.topicById.set(created.id, created);
    this.emit({ type: "topic-added", topic: created });
    return created;
  }

  /**
   * The intended Integration Target of a child that has no Branch yet. Placement uses the
   * Origin Commit as the child's tip, so out-of-order creation still gives one position,
   * and every ambiguity or duplicate Origin Commit rejects the request before any write.
   */
  private async planPendingPlacement(
    parent: TopicManifest,
    originCommit: string,
    repositoryPath: string,
  ): Promise<IntegrationTarget> {
    // The Topic Store owns real ids; placement only needs one distinct planning identity.
    const child: ChainTopic = {
      id: generateTopicId(),
      repository: parent.repository,
      parentTopicId: parent.id,
      originCommit,
      chainState: "pending",
    };
    const ancestry = await this.chainAncestry(
      repositoryPath,
      { id: child.id, ref: { commit: originCommit } },
      this.activeChildren(parent.id, child.id),
    );
    const plan = planChildInsertion({
      topics: this.chainTopics(),
      parentTopicId: parent.id,
      child,
      ancestry,
    });
    if (!plan.ok) throw new WorkDataError(plan.error.code, plan.error.message);
    const target = plan.value.edits.find((edit) => edit.topicId === child.id)?.integrationTarget;
    if (target === undefined) {
      throw new WorkDataError("broken-chain", "The Integration Chain gives no child position.");
    }
    return target;
  }

  /**
   * Activates one ready pending child. It revalidates current Branch tips, re-plans the
   * insertion, and writes the child's own activation last, so a failure leaves the previous
   * healthy chain in place and the child pending with a bounded explanation.
   */
  private async activatePendingChild(topic: TopicManifest): Promise<TopicManifest> {
    const parentTopicId = topic.parentTopicId;
    if (parentTopicId === undefined || topic.chainState !== "pending") return topic;
    if (topic.setup.state !== "ready") return topic;
    return this.serializeChain(parentTopicId, async () => {
      const current = this.topicById.get(topic.id) ?? topic;
      if (current.chainState !== "pending") return current;
      const parent = this.topicById.get(parentTopicId);
      if (parent === undefined) {
        return this.keepPending(current, "The Parent Topic of this child is missing.");
      }
      const repositoryPath = resolveBaseCheckout(this.requireConfig(), current.repository);
      if (repositoryPath === undefined) {
        return this.keepPending(current, "The repository of this Topic has no Base checkout.");
      }
      const insideParent = await this.ancestryReader().contains({
        repositoryPath,
        ancestor: { branch: current.branch },
        descendant: { branch: parent.branch },
      });
      if (insideParent !== true) {
        return this.keepPending(
          current,
          "The Parent Topic Branch no longer contains this child Branch.",
        );
      }
      const ancestry = await this.chainAncestry(
        repositoryPath,
        { id: current.id, ref: { branch: current.branch } },
        this.activeChildren(parentTopicId, current.id),
      );
      const plan = planChildActivation({
        topics: this.chainTopics(),
        topicId: current.id,
        ancestry,
      });
      if (!plan.ok) return this.keepPending(current, plan.error.message);
      if (!(await this.applyChainPlan(plan.value, current.id))) {
        return this.keepPending(current, "The Integration Chain change could not be stored.");
      }
      this.clearDiagnostic(current.id, PENDING_CHAIN_CODE);
      await this.refreshIntegrationStatuses();
      return this.topicById.get(current.id) ?? current;
    });
  }

  /**
   * Applies one Chain Plan. The Topic named by `last` is written last, so the chain becomes
   * complete in one final write; any failure restores every already written Topic.
   */
  private async applyChainPlan(plan: ChainPlan, last: string): Promise<boolean> {
    const ordered = [
      ...plan.edits.filter((edit) => edit.topicId !== last),
      ...plan.edits.filter((edit) => edit.topicId === last),
    ];
    const written: TopicManifest[] = [];
    try {
      for (const edit of ordered) {
        written.push(await this.options.topics.load(edit.topicId));
        this.publishTopic(
          await this.options.topics.update(edit.topicId, (topic) => withChainEdit(topic, edit)),
        );
      }
      return true;
    } catch {
      for (const previous of written.reverse()) {
        const restored = await this.options.topics
          .update(previous.id, () => previous)
          .catch(() => undefined);
        if (restored !== undefined) this.publishTopic(restored);
      }
      return false;
    }
  }

  /**
   * A synchronous ancestry view of one child against its active siblings. Every needed pair
   * is read from Git first, so chain planning stays pure; an unread pair stays ambiguous.
   */
  private async chainAncestry(
    repositoryPath: string,
    child: { id: string; ref: AncestryRef },
    siblings: readonly TopicManifest[],
  ): Promise<AncestryLookup> {
    const reader = this.ancestryReader();
    const answers = new Map<string, boolean | undefined>();
    for (const sibling of siblings) {
      const ref: AncestryRef = { branch: sibling.branch };
      answers.set(
        ancestryKey(sibling.id, child.id),
        await reader.contains({ repositoryPath, ancestor: ref, descendant: child.ref }),
      );
      answers.set(
        ancestryKey(child.id, sibling.id),
        await reader.contains({ repositoryPath, ancestor: child.ref, descendant: ref }),
      );
    }
    return (ancestor, descendant) =>
      ancestor.kind === "topic" && descendant.kind === "topic"
        ? answers.get(ancestryKey(ancestor.topicId, descendant.topicId))
        : undefined;
  }

  /**
   * A synchronous ancestry view over one complete family, including the Integration Branch.
   * Every ordered pair is read from Git before planning, so an explicit move, a reparenting,
   * and a full chain reset all decide from the same committed tips. A pair that Git cannot
   * answer, and any node without a local Branch, stays ambiguous.
   */
  private async familyAncestry(
    repositoryPath: string,
    repository: string,
    members: readonly TopicManifest[],
  ): Promise<AncestryLookup> {
    const integrationBranch = resolveIntegrationBranch(this.requireConfig(), repository);
    const entries: { node: ChainNode; ref: AncestryRef }[] = [
      ...(integrationBranch === undefined
        ? []
        : [{ node: INTEGRATION_BRANCH_NODE, ref: { branch: integrationBranch } }]),
      ...members.map((member) => ({
        node: topicNode(member.id),
        ref: { branch: member.branch } satisfies AncestryRef,
      })),
    ];
    const reader = this.ancestryReader();
    const answers = new Map<string, boolean | undefined>();
    for (const ancestor of entries) {
      for (const descendant of entries) {
        if (ancestor === descendant) continue;
        answers.set(
          ancestryKey(chainNodeKey(ancestor.node), chainNodeKey(descendant.node)),
          await reader.contains({
            repositoryPath,
            ancestor: ancestor.ref,
            descendant: descendant.ref,
          }),
        );
      }
    }
    return (ancestor, descendant) =>
      answers.get(ancestryKey(chainNodeKey(ancestor), chainNodeKey(descendant)));
  }

  /** The active children of one Parent Topic, without the Topic that is being placed. */
  private activeChildren(parentTopicId: string, exceptTopicId: string): TopicManifest[] {
    return [...this.topicById.values()].filter(
      (topic) =>
        topic.parentTopicId === parentTopicId &&
        topic.id !== exceptTopicId &&
        topic.chainState !== "pending",
    );
  }

  /**
   * The chain view of every known Topic. A root Topic without active children and without a
   * durable Integration Target reads as targeting the repository Integration Branch, so the
   * first child of a Topic created before any chain data existed still finds one position.
   */
  private chainTopics(): readonly ChainTopic[] {
    return [...this.topicById.values()].map((topic) => {
      if (topic.integrationTarget !== undefined) return topic;
      const integrationTarget = this.defaultIntegrationTarget(topic);
      return integrationTarget === undefined ? topic : { ...topic, integrationTarget };
    });
  }

  private ancestryReader(): BranchAncestryReader {
    const reader = this.options.ancestry;
    if (reader === undefined) {
      throw new WorkDataError("unavailable", "Git ancestry reading is not available.");
    }
    return reader;
  }

  /** Keeps a ready child outside the active chain and explains the refusal once. */
  private keepPending(topic: TopicManifest, reason: string): TopicManifest {
    this.addDiagnostic({
      topicId: topic.id,
      code: PENDING_CHAIN_CODE,
      message: boundMessage(reason),
    });
    return topic;
  }

  private addDiagnostic(diagnostic: TopicDiagnostic): void {
    this.diagnostics = this.diagnostics.filter(
      (entry) => entry.topicId !== diagnostic.topicId || entry.code !== diagnostic.code,
    );
    this.diagnostics.push(diagnostic);
    while (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
    this.emit({ type: "diagnostic-added", diagnostic });
  }

  private clearDiagnostic(topicId: string, code: string): void {
    const remaining = this.diagnostics.filter(
      (entry) => entry.topicId !== topicId || entry.code !== code,
    );
    if (remaining.length === this.diagnostics.length) return;
    this.diagnostics = remaining;
    this.emit({ type: "diagnostic-cleared", topicId, code });
  }

  private publishTopic(topic: TopicManifest): void {
    this.topicById.set(topic.id, topic);
    this.emit({ type: "topic-changed", topic });
  }

  retry(clientId: string, requestId: string, topicId: string): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `retry:${topicId}`, async () => {
      const topic = await this.options.topics.load(topicId);
      if (topic.setup.reason === "Start Point provisioning is not supported.") {
        throw new WorkDataError(
          "start-point-unsupported",
          "Start Point provisioning is not supported.",
        );
      }
      if (
        !isPendingChild(topic) &&
        topic.setup.state !== "setup-failed" &&
        topic.setup.state !== "provisioning"
      ) {
        throw new WorkDataError(
          "invalid-topic-state",
          "Only unfinished Topic setup can be retried.",
        );
      }
      this.topicById.set(topic.id, topic);
      // Re-read config from disk so a manually edited Repository Recipe applies on retry.
      this.config = await this.options.config.load();
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

  setNote(
    clientId: string,
    requestId: string,
    topicId: string,
    input: string,
  ): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `set-note:${topicId}:${input}`, () =>
      this.serializeTopic(topicId, async () => {
        const note = normalizeTopicNote(input);
        const topic = await this.options.topics.update(topicId, (current) => {
          const { note: _note, ...withoutNote } = current;
          return note === undefined ? withoutNote : { ...withoutNote, note };
        });
        this.topicById.set(topic.id, topic);
        this.emit({ type: "topic-changed", topic });
        return { status: "note-updated", topic };
      }),
    ) as Promise<TopicMutationResult>;
  }

  delete(clientId: string, requestId: string, topicId: string): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `delete:${topicId}`, () =>
      this.requestDeletion(topicId, clientId, this.requestKey(clientId, requestId)),
    ) as Promise<TopicMutationResult>;
  }

  /**
   * Moves one Topic into the family of another root Topic. The Topic leaves its old chain,
   * enters the new family at the position that current Git ancestry gives, and adopts the
   * new family's Focus.
   */
  changeParent(
    clientId: string,
    requestId: string,
    topicId: string,
    newParentTopicId: string,
  ): Promise<TopicMutationResult> {
    return this.runChainRequest(clientId, requestId, {
      kind: "change-parent",
      topicId,
      newParentTopicId,
    });
  }

  /** Reconnects the old chain and makes one child a root Topic again. */
  removeParent(clientId: string, requestId: string, topicId: string): Promise<TopicMutationResult> {
    return this.runChainRequest(clientId, requestId, { kind: "remove-parent", topicId });
  }

  /** Detaches one child and inserts it at an explicit place of its own Integration Chain. */
  moveInChain(
    clientId: string,
    requestId: string,
    topicId: string,
    target: IntegrationTarget,
  ): Promise<TopicMutationResult> {
    return this.runChainRequest(clientId, requestId, { kind: "move", topicId, target });
  }

  /** Rebuilds the Integration Chain of one family from current Git ancestry. */
  resetIntegrationTargets(
    clientId: string,
    requestId: string,
    topicId: string,
  ): Promise<TopicMutationResult> {
    return this.runChainRequest(clientId, requestId, { kind: "reset", topicId });
  }

  /**
   * Builds the read-only legacy migration preview. It reads Topic names, durable
   * relationship data, and committed Branch tips only; it writes no manifest and runs no
   * Git mutation.
   */
  async previewLegacyMigration(): Promise<LegacyMigrationPreviewResult> {
    this.config = await this.options.config.load();
    this.requireConfig();
    return { status: "migration-preview", preview: await this.buildLegacyPreview() };
  }

  /**
   * Applies the approved families of a fresh preview. Every approved family is re-planned
   * from current manifests and ancestry under its own chain lock, and is then written as a
   * whole through the recovery journal. A family that became ambiguous stays unchanged.
   */
  applyLegacyMigration(
    clientId: string,
    requestId: string,
    parentTopicIds?: readonly string[],
  ): Promise<LegacyMigrationApplyResult> {
    const requested = parentTopicIds === undefined ? undefined : [...parentTopicIds].toSorted();
    return this.deduplicate(
      clientId,
      requestId,
      `migrate-legacy:${JSON.stringify(requested ?? null)}`,
      () => this.applyLegacyMigrationSerial(requested),
    );
  }

  private async applyLegacyMigrationSerial(
    parentTopicIds: readonly string[] | undefined,
  ): Promise<LegacyMigrationApplyResult> {
    this.config = await this.options.config.load();
    this.requireConfig();
    const journal = this.requireMigrationJournal();
    const preview = await this.buildLegacyPreview();
    const families = preview.families.filter(
      (family) => parentTopicIds === undefined || parentTopicIds.includes(family.parentTopicId),
    );
    const skipped = [
      ...preview.skipped,
      ...(parentTopicIds ?? [])
        .filter((id) => !families.some((family) => family.parentTopicId === id))
        .map((topicId) => ({
          topicId,
          code: "unusable-family" as const,
          message: "This family is not part of the current preview.",
        })),
    ];
    if (families.length === 0) {
      return {
        status: "migration-applied",
        migrationId: null,
        appliedParentTopicIds: [],
        rolledBackParentTopicIds: [],
        skipped,
      };
    }

    return this.serializeChains(
      families.map((family) => family.parentTopicId),
      async () => {
        const manifests = new Map<string, TopicManifest>();
        for (const family of families) {
          for (const topicId of [
            family.parentTopicId,
            ...family.children.map((child) => child.topicId),
          ]) {
            manifests.set(topicId, await this.options.topics.load(topicId));
          }
        }
        const writes = migrationWrites(families, manifests);
        const result = await journal.run(writes, manifests, async (manifest) => {
          const written = await this.options.topics.update(manifest.id, () => manifest);
          this.publishTopic(written);
          return written;
        });
        await this.refreshIntegrationStatuses();
        return {
          status: "migration-applied" as const,
          migrationId: result.migrationId,
          appliedParentTopicIds: result.appliedParentTopicIds,
          rolledBackParentTopicIds: result.rolledBackParentTopicIds,
          skipped: [
            ...skipped,
            ...result.rolledBackParentTopicIds.map((topicId) => ({
              topicId,
              code: "unusable-family" as const,
              message: "The family was rolled back from its pre-migration backup.",
            })),
          ],
        };
      },
    );
  }

  /** The legacy families that names alone detect. Detection reads nothing from Git. */
  private legacyTopics(): LegacyTopic[] {
    return [...this.topicById.values()].map((topic) => ({
      id: topic.id,
      name: topic.name,
      repository: topic.repository,
      ready: topic.setup.state === "ready",
      ...(topic.parentTopicId === undefined ? {} : { parentTopicId: topic.parentTopicId }),
      ...(topic.integrationTarget === undefined
        ? {}
        : { integrationTarget: topic.integrationTarget }),
      ...(topic.chainState === undefined ? {} : { chainState: topic.chainState }),
    }));
  }

  private async buildLegacyPreview(): Promise<LegacyMigrationPreview> {
    const topics = this.legacyTopics();
    const detection = detectLegacyFamilies(topics);
    const ancestry = await this.legacyAncestry(detection.families);
    return planLegacyMigration({ topics, ancestry });
  }

  /**
   * Reads every ordered ancestry pair of every detected family once, so migration planning
   * stays pure. A repository without a Base checkout, and a pair that Git cannot answer,
   * stays ambiguous and keeps its family unchanged.
   */
  private async legacyAncestry(families: readonly LegacyNameFamily[]): Promise<AncestryLookup> {
    const answers = new Map<string, boolean | undefined>();
    if (families.length === 0) return () => undefined;
    const reader = this.ancestryReader();
    for (const family of families) {
      const members = [family.parentTopicId, ...family.childTopicIds]
        .map((id) => this.topicById.get(id))
        .filter((topic): topic is TopicManifest => topic !== undefined);
      const repository = members[0]?.repository;
      if (repository === undefined) continue;
      const repositoryPath = resolveBaseCheckout(this.requireConfig(), repository);
      if (repositoryPath === undefined) continue;
      for (const ancestor of members) {
        for (const descendant of members) {
          if (ancestor.id === descendant.id) continue;
          answers.set(
            ancestryKey(ancestor.id, descendant.id),
            await reader.contains({
              repositoryPath,
              ancestor: { branch: ancestor.branch },
              descendant: { branch: descendant.branch },
            }),
          );
        }
      }
    }
    return (ancestor, descendant) =>
      ancestor.kind === "topic" && descendant.kind === "topic"
        ? answers.get(ancestryKey(ancestor.topicId, descendant.topicId))
        : undefined;
  }

  /**
   * Settles an interrupted legacy migration. A family that the journal does not record as
   * complete returns to its pre-migration manifests, so a crash during a run never leaves a
   * mixed or lost relationship. It is safe to run when no journal exists.
   */
  private async recoverLegacyMigration(): Promise<void> {
    const journal = this.options.migrations;
    if (journal === undefined) return;
    await journal
      .recover(async (manifest) => this.options.topics.update(manifest.id, () => manifest))
      .catch(() => []);
  }

  private requireMigrationJournal(): LegacyMigrationJournal {
    const journal = this.options.migrations;
    if (journal === undefined) {
      throw new WorkDataError("unavailable", "Legacy migration storage is not available.");
    }
    return journal;
  }

  private runChainRequest(
    clientId: string,
    requestId: string,
    action: ChainMaintenanceAction,
  ): Promise<TopicMutationResult> {
    const fingerprint = `chain:${JSON.stringify(action)}`;
    return this.deduplicate(clientId, requestId, fingerprint, () =>
      this.runChainAction(action, clientId, this.requestKey(clientId, requestId), false),
    ) as Promise<TopicMutationResult>;
  }

  /**
   * Runs one chain maintenance action under the chain lock of every family that it touches.
   * Planning, confirmation, and every manifest write happen inside that lock, so two chain
   * actions can never interleave their rewiring.
   */
  private async runChainAction(
    action: ChainMaintenanceAction,
    clientId: string,
    originalRequest: string,
    approved: boolean,
  ): Promise<TopicMutationResult> {
    this.config = await this.options.config.load();
    this.requireConfig();
    const topic = await this.reloadTopic(action.topicId);
    const families = [topic.parentTopicId ?? topic.id];
    if (action.kind === "change-parent") families.push(action.newParentTopicId);
    return this.serializeChains(families, () =>
      this.chainActionSerial(action, clientId, originalRequest, approved),
    );
  }

  private async chainActionSerial(
    action: ChainMaintenanceAction,
    clientId: string,
    originalRequest: string,
    approved: boolean,
  ): Promise<TopicMutationResult> {
    const topic = await this.reloadTopic(action.topicId);
    requireChainReady(topic);
    const plan = await this.planChainAction(action, topic);
    if (plan.confirmationRequired !== undefined && !approved) {
      return this.requireConfirmation({
        clientId,
        originalRequest,
        topicId: topic.id,
        action: "topic.change-chain",
        operation: "chain",
        approvedActions: new Set(),
        chainAction: action,
        text: plan.confirmationRequired,
      });
    }
    this.setOperation({ topicId: topic.id, kind: "change-chain", state: "running" });
    try {
      if (!(await this.applyChainPlan(plan, topic.id))) {
        throw new WorkDataError(
          "chain-write-failed",
          "The Integration Chain change could not be stored.",
        );
      }
    } finally {
      this.clearOperation(topic.id);
    }
    if (action.kind === "change-parent") await this.adoptFamilyFocus(action.newParentTopicId);
    this.clearDiagnostic(topic.id, PENDING_CHAIN_CODE);
    await this.refreshIntegrationStatuses();
    return { status: "chain-changed", topic: this.topicById.get(topic.id) ?? topic };
  }

  /** Plans one maintenance action against current manifests and committed Branch tips. */
  private async planChainAction(
    action: ChainMaintenanceAction,
    topic: TopicManifest,
  ): Promise<ChainPlan> {
    if (action.kind === "remove-parent") {
      return this.requirePlan(planRemoveParent({ topics: this.chainTopics(), topicId: topic.id }));
    }
    const repositoryPath = resolveBaseCheckout(this.requireConfig(), topic.repository);
    if (repositoryPath === undefined) {
      throw new WorkDataError(
        "missing-base-checkout",
        "The repository of this Topic has no Base checkout.",
      );
    }
    if (action.kind === "change-parent") {
      const parent = await this.reloadTopic(action.newParentTopicId);
      requireChainReady(parent);
      if (parent.repository !== topic.repository) {
        throw new WorkDataError(
          "cross-repository",
          "The new Parent Topic is in another repository.",
        );
      }
      const ancestry = await this.familyAncestry(repositoryPath, topic.repository, [
        parent,
        ...this.activeChildren(parent.id, topic.id),
        topic,
      ]);
      return this.requirePlan(
        planChangeParent({
          topics: this.chainTopics(),
          topicId: topic.id,
          newParentTopicId: parent.id,
          ancestry,
        }),
      );
    }
    if (action.kind === "move") {
      const parentTopicId = topic.parentTopicId;
      if (parentTopicId === undefined) {
        throw new WorkDataError("not-allowed", "Only a child Topic can move inside a chain.");
      }
      const parent = await this.reloadTopic(parentTopicId);
      const ancestry = await this.familyAncestry(repositoryPath, topic.repository, [
        parent,
        ...this.activeChildren(parentTopicId, topic.id),
        topic,
      ]);
      return this.requirePlan(
        planChainMove({
          topics: this.chainTopics(),
          topicId: topic.id,
          target: action.target,
          ancestry,
        }),
      );
    }
    if (topic.parentTopicId !== undefined) {
      throw new WorkDataError("not-allowed", "Only a Parent Topic can reset a chain.");
    }
    const ancestry = await this.familyAncestry(repositoryPath, topic.repository, [
      topic,
      ...this.activeChildren(topic.id, topic.id),
    ]);
    return this.requirePlan(
      planIntegrationTargetReset({
        topics: this.chainTopics(),
        parentTopicId: topic.id,
        ancestry,
      }),
    );
  }

  /** A moved Topic joins the Focus of the family that adopts it. */
  private async adoptFamilyFocus(parentTopicId: string): Promise<void> {
    const parent = this.topicById.get(parentTopicId);
    if (parent === undefined) return;
    for (const member of this.familyMembers(parentTopicId)) {
      if (member.focused === parent.focused) continue;
      await this.writeFocus(member.id, parent.focused);
    }
  }

  private requirePlan(result: ChainResult<ChainPlan>): ChainPlan {
    if (!result.ok) throw new WorkDataError(result.error.code, result.error.message);
    return result.value;
  }

  /** Reloads one Topic from its manifest and publishes it into the live snapshot. */
  private async reloadTopic(topicId: string): Promise<TopicManifest> {
    const topic = await this.options.topics.load(topicId);
    this.topicById.set(topic.id, topic);
    return topic;
  }

  /**
   * Sets the Focus of one Topic and of its complete one-level family, so a Parent Topic and
   * its children never split across the Focus separator. It is idempotent per Topic.
   */
  setFocus(
    clientId: string,
    requestId: string,
    topicId: string,
    focused: boolean,
  ): Promise<TopicMutationResult> {
    return this.deduplicate(clientId, requestId, `set-focus:${topicId}:${focused}`, () =>
      this.serializeTopic(topicId, async () => {
        const topic = await this.writeFocus(topicId, focused);
        for (const member of this.familyMembers(topicId)) {
          if (member.id === topic.id) continue;
          await this.writeFocus(member.id, focused);
        }
        return { status: "refocused", topic };
      }),
    ) as Promise<TopicMutationResult>;
  }

  private async writeFocus(topicId: string, focused: boolean): Promise<TopicManifest> {
    const topic = await this.options.topics.update(topicId, (current) =>
      current.focused === focused ? current : { ...current, focused },
    );
    this.topicById.set(topic.id, topic);
    this.emit({ type: "topic-changed", topic });
    return topic;
  }

  /** The Parent Topic and every child of the one-level family that contains this Topic. */
  private familyMembers(topicId: string): TopicManifest[] {
    const topic = this.topicById.get(topicId);
    if (topic === undefined) return [];
    const rootId = topic.parentTopicId ?? topic.id;
    const root = this.topicById.get(rootId) ?? topic;
    return [root, ...[...this.topicById.values()].filter((item) => item.parentTopicId === root.id)];
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
      if (pending.operation === "chain") {
        const action = pending.chainAction;
        if (action === undefined) {
          throw new WorkDataError("invalid-confirmation", "Confirmation token is invalid.");
        }
        return this.runChainAction(action, pending.clientId, pending.originalRequest, true);
      }
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
      // Only a policy action can widen the approved set; a chain edge never becomes a policy.
      if (pending.action !== "topic.change-chain") approved.add(pending.action);
      return this.provision(
        pending.topicId,
        pending.originalRequest,
        approved,
        pending.clientId,
        pending.startPoint,
      );
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
    startPoint?: TopicCreationRequest["startPoint"],
  ): Promise<TopicMutationResult> {
    return this.serializeTopic(topicId, () =>
      this.provisionSerial(topicId, originalRequest, approvedActions, clientId, startPoint),
    );
  }

  private async provisionSerial(
    topicId: string,
    originalRequest: string,
    approvedActions: ReadonlySet<ActionId>,
    clientId: string,
    startPoint?: TopicCreationRequest["startPoint"],
  ): Promise<TopicMutationResult> {
    const config = this.requireConfigured();
    this.setOperation({ topicId, kind: "provision", state: "running" });
    const repository = this.topicById.get(topicId)?.repository;
    const recipe =
      repository === undefined ? [] : (config.repositories[repository]?.setupCommands ?? []);
    const baseCheckout =
      repository === undefined ? undefined : resolveBaseCheckout(config, repository);
    const request: ProvisionRequest = {
      topicId,
      workBase: config.workBase!,
      policies: config.policies,
      recipe,
      approvedActions,
      ...(startPoint === undefined ? {} : { startPoint }),
      onSetupProgress: (progress) =>
        this.setOperation({
          topicId,
          kind: "provision",
          state: "running",
          detail: `setup ${progress.index + 1}/${progress.total}`,
        }),
    };
    if (baseCheckout !== undefined) request.baseCheckout = baseCheckout;
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
    await this.refreshTopicWorktreePresence(result.topic);

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
        ...(startPoint === undefined ? {} : { startPoint }),
        text: `Allow ${result.action} for Topic ${result.topic.name}?`,
      });
    }
    this.clearOperation(topicId);
    void this.refreshPullRequest(topicId);
    const outcome = provisionResult(result);
    // Finished setup is the only moment at which a pending child may enter the active chain.
    if (outcome.status === "ready") {
      return { status: "ready", topic: await this.activatePendingChild(outcome.topic) };
    }
    return outcome;
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

  /**
   * Deletes one Topic record and repairs its Integration Chain in the same step: an active
   * child hands its own Integration Target to its successor, and a Parent Topic that still
   * has children is refused. The rewiring is written first and restored when the record
   * deletion fails, so the family never keeps a link to a Topic that no longer exists.
   */
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
    return this.serializeChain(topic.parentTopicId ?? topic.id, async () => {
      this.topicById.set(topic.id, topic);
      const plan = this.requirePlan(planTopicDeletion({ topics: this.chainTopics(), topicId }));
      const previous = await this.captureTopics(plan.edits.map((edit) => edit.topicId));
      if (plan.edits.length > 0 && !(await this.applyChainPlan(plan, topicId))) {
        throw new WorkDataError(
          "chain-write-failed",
          "The Integration Chain change could not be stored.",
        );
      }
      this.setOperation({ topicId, kind: "delete", state: "running" });
      try {
        await this.options.topics.delete(topicId);
      } catch (error) {
        await this.restoreTopics(previous);
        this.clearOperation(topicId);
        throw error;
      }
      this.clearOperation(topicId);
      this.topicById.delete(topicId);
      if (this.pullRequestById.delete(topicId)) {
        this.emit({ type: "pull-request-changed", topicId, pullRequest: null });
      }
      this.integrationStatusById.delete(topicId);
      this.emit({ type: "topic-removed", topicId });
      await this.refreshIntegrationStatuses();
      return { status: "deleted", topicId };
    });
  }

  private async captureTopics(topicIds: readonly string[]): Promise<TopicManifest[]> {
    const captured: TopicManifest[] = [];
    for (const topicId of topicIds) captured.push(await this.options.topics.load(topicId));
    return captured;
  }

  private async restoreTopics(previous: readonly TopicManifest[]): Promise<void> {
    for (const topic of previous) {
      const restored = await this.options.topics
        .update(topic.id, () => topic)
        .catch(() => undefined);
      if (restored !== undefined) this.publishTopic(restored);
    }
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
      kind: confirmationOperationKind(input.operation),
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

  private async serializeCreation<T>(
    repository: string,
    branch: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return serializeIn(this.creationQueues, `${repository}\0${branch}`, operation);
  }

  /** Serializes every chain change of one family, so two children cannot lose a rewiring. */
  private async serializeChain<T>(parentTopicId: string, operation: () => Promise<T>): Promise<T> {
    return serializeIn(this.chainQueues, parentTopicId, operation);
  }

  /**
   * Serializes one operation against every family that it touches. Locks are taken in one
   * global key order, so two reparenting actions between the same two families cannot
   * deadlock each other.
   */
  private serializeChains<T>(
    parentTopicIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return [...new Set(parentTopicIds)]
      .toSorted()
      .reduceRight<() => Promise<T>>(
        (run, key) => () => this.serializeChain(key, run),
        operation,
      )();
  }

  private async serializeTopic<T>(topicId: string, operation: () => Promise<T>): Promise<T> {
    return serializeIn(this.topicQueues, topicId, operation);
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

/** A Topic can only take part in chain maintenance once its setup and insertion finished. */
function requireChainReady(topic: TopicManifest): void {
  if (topic.setup.state !== "ready") {
    throw new WorkDataError("invalid-topic-state", "Topic setup is not ready.");
  }
  if (topic.chainState === "pending") {
    throw new WorkDataError(
      "invalid-topic-state",
      "This Topic is still pending in its Integration Chain.",
    );
  }
}

/** The live operation kind that one prepared confirmation shows in the dashboard. */
function confirmationOperationKind(
  operation: PendingConfirmation["operation"],
): TopicOperation["kind"] {
  switch (operation) {
    case "terminal":
      return "open-terminal";
    case "agent":
      return "open-agent";
    case "chain":
      return "change-chain";
    default:
      return operation;
  }
}

function integrationBranchMap(config: WorkConfig | null): Readonly<Record<string, string>> {
  if (config === null) return {};
  const entries: [string, string][] = [];
  for (const repository of Object.keys(config.repositories)) {
    const branch = resolveIntegrationBranch(config, repository);
    if (branch !== undefined) entries.push([repository, branch]);
  }
  return Object.fromEntries(entries);
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

function sameIntegrationStatus(
  left: IntegrationStatus | undefined,
  right: IntegrationStatus,
): boolean {
  return (
    left !== undefined &&
    left.kind === right.kind &&
    left.target === right.target &&
    left.ahead === right.ahead &&
    left.behind === right.behind &&
    left.detail === right.detail
  );
}

function validateCreationRequest(input: TopicCreationRequest): void {
  const keys = Object.keys(input);
  if (keys.some((key) => !["name", "branch", "repository", "startPoint"].includes(key))) {
    throw new WorkDataError("invalid-topic", "Topic creation input has unknown fields.");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 200) {
    throw new WorkDataError("invalid-topic", "Topic name is invalid.");
  }
  if (typeof input.repository !== "string" || input.repository.length > 200) {
    throw new WorkDataError("invalid-topic", "Topic repository is invalid.");
  }
  parseRepository(input.repository);
  if (typeof input.branch !== "string" || !isValidBranchName(input.branch)) {
    throw new WorkDataError("invalid-topic", "Topic branch is not a valid Git branch name.");
  }
  if (input.startPoint === undefined) return;
  validateStartPoint(input.startPoint);
}

/** The daemon-side child-creation input after validation, with a resolved Branch. */
interface ChildRequest {
  parentTopicId: string;
  name: string;
  branch: string;
  startPoint: TopicStartPoint;
}

function validateChildCreationRequest(input: ChildTopicCreationRequest): ChildRequest {
  const keys = Object.keys(input);
  if (keys.some((key) => !["parentTopicId", "name", "branch", "startPoint"].includes(key))) {
    throw new WorkDataError("invalid-topic", "Child creation input has unknown fields.");
  }
  if (typeof input.parentTopicId !== "string" || !isTopicId(input.parentTopicId)) {
    throw new WorkDataError("invalid-topic", "Parent Topic id is invalid.");
  }
  if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 200) {
    throw new WorkDataError("invalid-topic", "Topic name is invalid.");
  }
  // An omitted Branch uses the same deterministic name conversion as normal creation.
  const branch = input.branch ?? defaultBranchForTopicName(input.name);
  if (typeof branch !== "string" || !isValidBranchName(branch)) {
    throw new WorkDataError("invalid-topic", "Topic branch is not a valid Git branch name.");
  }
  return {
    parentTopicId: input.parentTopicId,
    name: input.name,
    branch,
    startPoint: validateStartPoint(input.startPoint),
  };
}

function validateStartPoint(input: unknown): TopicStartPoint {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkDataError("invalid-start-point", "Start Point is invalid.");
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["commit", "sourceCheckout"].includes(key)) ||
    typeof value["commit"] !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value["commit"]) ||
    typeof value["sourceCheckout"] !== "string" ||
    value["sourceCheckout"].length === 0 ||
    value["sourceCheckout"].length > 1_000 ||
    !isAbsolute(value["sourceCheckout"])
  ) {
    throw new WorkDataError("invalid-start-point", "Start Point is invalid.");
  }
  return { commit: value["commit"], sourceCheckout: value["sourceCheckout"] };
}

/** A ready child that is still outside the active chain, so Retry Setup can finish it. */
function isPendingChild(topic: TopicManifest): boolean {
  return (
    topic.setup.state === "ready" &&
    topic.chainState === "pending" &&
    topic.parentTopicId !== undefined
  );
}

/** Applies one Chain Edit to a Topic manifest; `parentTopicId: null` clears the family link. */
function withChainEdit(topic: TopicManifest, edit: ChainEdit): TopicManifest {
  const parentTopicId =
    edit.parentTopicId === undefined ? topic.parentTopicId : (edit.parentTopicId ?? undefined);
  const integrationTarget = edit.integrationTarget ?? topic.integrationTarget;
  const chainState = edit.chainState ?? topic.chainState;
  const { parentTopicId: _parent, integrationTarget: _target, chainState: _state, ...rest } = topic;
  return {
    ...rest,
    ...(parentTopicId === undefined ? {} : { parentTopicId }),
    ...(integrationTarget === undefined ? {} : { integrationTarget }),
    ...(chainState === undefined ? {} : { chainState }),
  };
}

function ancestryKey(ancestor: string, descendant: string): string {
  return `${ancestor}->${descendant}`;
}

/** Runs one operation after every earlier operation that shares the same queue key. */
async function serializeIn<T>(
  queues: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

async function isDirectory(path: string, inspect: typeof stat): Promise<boolean> {
  try {
    return (await inspect(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Splits a validated owner/name Topic repository into pull request target fields. */
function prTarget(repository: string): { owner: string; repo: string } {
  const reference = parseRepository(repository);
  return { owner: reference.owner, repo: reference.name };
}
