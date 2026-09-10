import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ACTION_IDS,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
  validateTopicGraph,
} from "../shared/index.ts";
import type {
  ConfigStore,
  TopicManifest,
  TopicStore,
  WorkConfig,
  WorkPaths,
} from "../shared/index.ts";
import { BranchAncestryReader } from "./branch-ancestry.ts";
import { IntegrationBranchResolver } from "./integration-branch.ts";
import { IntegrationStatusObserver } from "./integration-status.ts";
import { LegacyMigrationJournal } from "./legacy-migration.ts";
import type { ProvisionRequest, ProvisionResult } from "./provisioner.ts";
import { TopicService } from "./topic-service.ts";
import type { TopicMutationResult } from "./topic-service.ts";
import {
  RecordingProcessRunner,
  TestGitRepository,
  createParentBranchScenario,
  createTemporaryRoot,
  removeTemporaryRoots,
} from "../test-support/git-repository.ts";
import type { ParentBranchScenario } from "../test-support/git-repository.ts";

const REPOSITORY = "LedgerHQ/revault";
/**
 * Generous upper bound of one complete Integration Status refresh over twenty Topics on a
 * loaded machine. It protects against unbounded work, not against small timing noise.
 */
const REFRESH_BUDGET_MS = 60_000;

const roots: string[] = [];

afterEach(async () => {
  await removeTemporaryRoots(roots);
});

/**
 * A provisioner that prepares real local Git state: it creates the Topic Branch at its
 * Start Point and one real Worktree, exactly as the product provisioner does through `wt`.
 * It is idempotent, so a daemon restart can re-run it safely.
 */
class GitWorktreeProvisioner {
  readonly requests: ProvisionRequest[] = [];
  readonly failBranches = new Set<string>();
  gate: Promise<void> | undefined;

  private readonly topics: TopicStore;
  private readonly repository: TestGitRepository;
  private readonly worktreeBase: string;

  constructor(topics: TopicStore, repository: TestGitRepository, worktreeBase: string) {
    this.topics = topics;
    this.repository = repository;
    this.worktreeBase = worktreeBase;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    this.requests.push(request);
    await this.gate;
    let topic = await this.topics.load(request.topicId);
    if (this.failBranches.has(topic.branch)) {
      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: { ...current.setup, state: "setup-failed", reason: "A Setup command failed." },
      }));
      return { status: "failed", reason: "A Setup command failed.", topic };
    }
    // Retry Setup carries no Start Point, so the immutable Origin Commit takes over.
    const startPoint = request.startPoint?.commit ?? topic.originCommit;
    if (startPoint !== undefined && !(await this.branchExists(topic.branch))) {
      await this.repository.createBranch(topic.branch, startPoint);
    }
    const worktreePath = join(this.worktreeBase, topic.branch);
    if (!existsSync(worktreePath)) await this.repository.addWorktree(worktreePath, topic.branch);
    topic = await this.topics.update(topic.id, (current) => ({
      ...current,
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
      },
      worktreePath,
    }));
    return { status: "ready", topic };
  }

  private async branchExists(branch: string): Promise<boolean> {
    return this.repository
      .tip(branch)
      .then(() => true)
      .catch(() => false);
  }
}

interface World {
  root: string;
  workBase: string;
  worktreeBase: string;
  scenario: ParentBranchScenario;
  repository: TestGitRepository;
  service: TopicService;
  topics: TopicStore;
  config: ConfigStore;
  paths: WorkPaths;
  runner: RecordingProcessRunner;
  provisioner: GitWorktreeProvisioner;
  /** Number of live timers that the Service started. */
  timers: () => number;
  parent: TopicManifest;
}

/** Configuration without an Integration Branch, so every world exercises inference. */
function configuration(workBase: string): WorkConfig {
  return {
    version: 1,
    workBase,
    policies: {
      defaults: Object.fromEntries(ACTION_IDS.map((action) => [action, "allow"])),
      repositories: {},
      topics: {},
    },
    repositories: { [REPOSITORY]: { setupCommands: [] } },
  };
}

interface WorldOptions {
  /** Creates the Parent Topic through the daemon. Defaults to true. */
  parentTopic?: boolean;
}

async function world(options: WorldOptions = {}): Promise<World> {
  const root = await createTemporaryRoot("pi-work-workflow-");
  roots.push(root);
  const workBase = join(root, "ledger");
  const worktreeBase = join(root, "wt");
  await mkdir(workBase, { recursive: true });
  await mkdir(worktreeBase, { recursive: true });
  const scenario = await createParentBranchScenario(workBase);
  const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
  const config = createConfigStore(paths);
  await config.save(configuration(workBase));
  const topics = createTopicStore(paths);
  const runner = new RecordingProcessRunner();
  const provisioner = new GitWorktreeProvisioner(topics, scenario.repository, worktreeBase);
  const timers = new Set<object>();
  const service = new TopicService({
    config,
    topics,
    provisioner,
    integrationBranches: new IntegrationBranchResolver({ config, runner }),
    integrationStatuses: new IntegrationStatusObserver({ runner }),
    ancestry: new BranchAncestryReader({ runner }),
    migrations: new LegacyMigrationJournal({ paths }),
    setInterval: ((): ReturnType<typeof setInterval> => {
      const handle = {};
      timers.add(handle);
      return handle as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((handle: object) => timers.delete(handle)) as unknown as typeof clearInterval,
  });
  await service.start();
  const item: World = {
    root,
    workBase,
    worktreeBase,
    scenario,
    repository: scenario.repository,
    service,
    topics,
    config,
    paths,
    runner,
    provisioner,
    timers: () => timers.size,
    parent: undefined as unknown as TopicManifest,
  };
  if (options.parentTopic !== false) {
    const created = await service.create("test-client", "create-parent", {
      name: "Parent",
      branch: scenario.parentBranch,
      repository: REPOSITORY,
    });
    if (created.status !== "ready") throw new Error(`Parent Topic is ${created.status}.`);
    item.parent = created.topic;
  }
  return item;
}

let nextRequestId = 0;

function createChild(
  item: World,
  name: string,
  branch: string,
  commit: string,
): Promise<TopicMutationResult> {
  nextRequestId += 1;
  return item.service.createChild("test-client", `child-${nextRequestId}`, {
    parentTopicId: item.parent.id,
    name,
    branch,
    startPoint: { commit, sourceCheckout: item.repository.path },
  });
}

function topicByName(item: World, name: string): TopicManifest {
  const topic = item.service.snapshot().topics.find((candidate) => candidate.name === name);
  if (topic === undefined) throw new Error(`No Topic named ${name}.`);
  return topic;
}

/** The active Integration Chain, from the Integration Branch to the Parent Topic. */
function chain(item: World): string[] {
  const topics = item.service.snapshot().topics.filter((topic) => topic.chainState !== "pending");
  const order: string[] = ["integration"];
  let cursor = "integration-branch";
  for (let step = 0; step < topics.length; step += 1) {
    const next = topics.find((topic) => {
      // A root Topic without active children targets the Integration Branch by default.
      const target =
        topic.integrationTarget ??
        (topic.parentTopicId === undefined ? { kind: "integration-branch" as const } : undefined);
      if (target === undefined) return false;
      return cursor === "integration-branch"
        ? target.kind === "integration-branch"
        : target.kind === "topic" && target.topicId === cursor;
    });
    if (next === undefined) break;
    order.push(next.name);
    cursor = next.id;
  }
  return order;
}

/** The observed Integration Status of one Topic, as `kind target ahead/behind`. */
function statusOf(item: World, name: string): string {
  const topic = topicByName(item, name);
  const status = item.service.snapshot().integrationStatuses[topic.id];
  if (status === undefined) return "missing";
  const counts =
    status.ahead === undefined || status.behind === undefined
      ? ""
      : ` ${status.ahead}/${status.behind}`;
  return `${status.kind} ${status.target ?? "-"}${counts}`;
}

/** The Worktree of one ready Topic. */
function worktreeOf(item: World, name: string): string {
  const worktree = topicByName(item, name).worktreePath;
  if (worktree === null) throw new Error(`Topic ${name} has no Worktree.`);
  return worktree;
}

/** Proves that reading Integration state never changed the repository. */
function expectNoGitMutation(item: World): void {
  expect(item.runner.mutatingRequests.map((request) => request.args.join(" "))).toEqual([]);
}

describe("Integration Chain workflow", () => {
  test("follows the rebase cascade edge by edge with the correct targets and counts", async () => {
    const item = await world();
    const { checkpoints, repository } = item.scenario;
    expect((await createChild(item, "B", "feat-b", checkpoints[1]!)).status).toBe("ready");
    expect((await createChild(item, "C", "feat-c", checkpoints[2]!)).status).toBe("ready");
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
    expect(validateTopicGraph(item.service.snapshot().topics)).toBeUndefined();

    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "B")).toBe("current main 2/0");
    expect(statusOf(item, "C")).toBe("current feat-b 1/0");
    expect(statusOf(item, "Parent")).toBe("current feat-c 1/0");

    // A teammate advanced the Integration Branch; the first broken edge is the first child.
    await repository.commit("shared.txt", "integration step");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "B")).toBe("behind main 2/1");
    expect(statusOf(item, "C")).toBe("current feat-b 1/0");
    expect(statusOf(item, "Parent")).toBe("current feat-c 1/0");

    // Each manual rebase step repairs one edge and moves the cascade to the next one.
    await repository.rebase(worktreeOf(item, "B"), "main");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "B")).toBe("current main 2/0");
    expect(statusOf(item, "C")).toBe("behind feat-b 3/3");

    await repository.rebase(worktreeOf(item, "C"), "feat-b");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "C")).toBe("current feat-b 1/0");
    expect(statusOf(item, "Parent")).toBe("behind feat-c 4/4");

    await repository.rebase(worktreeOf(item, "Parent"), "feat-c");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "Parent")).toBe("current feat-c 1/0");
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
    expectNoGitMutation(item);
  });

  test("shows Conflict for a predicted conflict and Unknown without usable local data", async () => {
    const item = await world();
    const { checkpoints, repository } = item.scenario;
    await createChild(item, "B", "feat-b", checkpoints[1]!);
    // The Integration Branch changed the same file as the first child Branch.
    await repository.commit("parent-1.txt", "integration rewrite");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "B")).toBe("conflict main 2/1");

    // A ready Topic whose recorded Worktree disappeared cannot be observed.
    await rm(worktreeOf(item, "B"), { recursive: true, force: true });
    await item.service.refreshWorktreePresence();
    await item.service.refreshIntegrationStatuses();
    const unknown = item.service.snapshot().integrationStatuses[topicByName(item, "B").id];
    expect(unknown?.kind).toBe("unknown");
    expect(unknown?.detail).toBe("The recorded Worktree of this Topic is missing.");
    expectNoGitMutation(item);
  });

  test("infers the root Integration Branch once and keeps it across Base checkout switches", async () => {
    const item = await world();
    expect(item.service.snapshot().integrationBranches[REPOSITORY]).toBe("main");
    const stored = await item.config.load();
    expect(stored?.repositories[REPOSITORY]?.integrationBranch).toBe("main");

    // The operator switched the Base checkout to another Branch after the first inference.
    await item.repository.git("checkout", "-b", "release");
    const restarted = await restart(item);
    expect(restarted.snapshot().integrationBranches[REPOSITORY]).toBe("main");
    await restarted.refreshIntegrationStatuses();
    expect(restarted.snapshot().integrationStatuses[item.parent.id]?.target).toBe("main");
    restarted.stop();
    expectNoGitMutation(item);
  });

  test("rebuilds the chain and every status after a daemon restart", async () => {
    const item = await world();
    const { checkpoints } = item.scenario;
    await createChild(item, "B", "feat-b", checkpoints[1]!);
    await createChild(item, "C", "feat-c", checkpoints[2]!);

    const restarted = await restart(item);
    const names = restarted.snapshot().topics.map((topic) => topic.name);
    expect(names).toEqual(["Parent", "B", "C"]);
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
    const statuses = restarted.snapshot().integrationStatuses;
    expect(Object.values(statuses).map((status) => status.kind)).toEqual([
      "current",
      "current",
      "current",
    ]);
    restarted.stop();
    expectNoGitMutation(item);
  });

  test("keeps the healthy chain through setup failure, Retry Setup, and deletion", async () => {
    const item = await world();
    const { checkpoints } = item.scenario;
    await createChild(item, "B", "feat-b", checkpoints[1]!);
    item.provisioner.failBranches.add("feat-c");

    const failed = await createChild(item, "C", "feat-c", checkpoints[2]!);
    expect(failed.status).toBe("failed");
    expect(topicByName(item, "C").chainState).toBe("pending");
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "C")).toBe("unknown -");

    item.provisioner.failBranches.clear();
    const retried = await item.service.retry("test-client", "retry-1", topicByName(item, "C").id);
    expect(retried.status).toBe("ready");
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);

    // Deleting an active child hands its Integration Target to its successor.
    const pending = await item.service.delete("test-client", "delete-1", topicByName(item, "C").id);
    if (pending.status !== "confirmation-required") throw new Error("Expected confirmation.");
    const deleted = await item.service.confirm("test-client", "confirm-1", pending.token);
    expect(deleted.status).toBe("deleted");
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    const parentDeletion = await item.service.delete("test-client", "delete-2", item.parent.id);
    if (parentDeletion.status !== "confirmation-required")
      throw new Error("Expected confirmation.");
    await expect(
      item.service.confirm("test-client", "confirm-2", parentDeletion.token),
    ).rejects.toMatchObject({ code: "not-allowed" });
    expectNoGitMutation(item);
  });

  test("keeps a ready child pending when the Parent Branch was rewritten during setup", async () => {
    const item = await world();
    const { checkpoints, repository } = item.scenario;
    let release = (): void => undefined;
    item.provisioner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creation = createChild(item, "C", "feat-c", checkpoints[2]!);
    for (
      let attempt = 0;
      attempt < 200 && item.service.snapshot().topics.length < 2;
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    expect(topicByName(item, "C").chainState).toBe("pending");
    await item.service.refreshIntegrationStatuses();
    expect(statusOf(item, "C")).toBe("unknown -");

    // The operator rewrote the Parent Branch while the child Worktree was prepared.
    const parentWorktree = worktreeOf(item, "Parent");
    await repository.git("-C", parentWorktree, "reset", "--hard", checkpoints[1]!);
    await repository.commit("rewritten.txt", "new parent work", parentWorktree);
    release();

    expect((await creation).status).toBe("ready");
    expect(topicByName(item, "C").chainState).toBe("pending");
    expect(chain(item)).toEqual(["integration", "Parent"]);
    expect(item.service.snapshot().diagnostics.map((entry) => entry.code)).toEqual([
      "chain-pending",
    ]);
    expectNoGitMutation(item);
  });

  test("refreshes on demand without a timer, a watcher, or a fetch", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", item.scenario.checkpoints[1]!);
    // Only the Worktree presence poll exists; Integration state has no timer of its own.
    const timersAfterStart = item.timers();
    item.runner.clear();

    // Dashboard open and the `r` key drive the same explicit refresh sequence.
    await item.service.refreshWorktreePresence();
    await item.service.refreshIntegrationBranches();
    await item.service.refreshIntegrationStatuses();
    const afterFirstRefresh = item.runner.requests.length;
    await item.service.refreshIntegrationStatuses();

    expect(item.timers()).toBe(timersAfterStart);
    expect(item.runner.countOf("fetch")).toBe(0);
    expect(item.runner.countOf("pull")).toBe(0);
    expectNoGitMutation(item);
    // Each refresh reads the two Branch tips of each Topic and nothing else, because every
    // resolved SHA pair is already cached.
    expect(afterFirstRefresh).toBe(4);
    expect(item.runner.countOf("rev-parse")).toBe(8);
    expect(item.runner.countOf("rev-list")).toBe(0);
  });

  test("keeps a twenty-Topic refresh bounded in concurrency, output, and wall time", async () => {
    const item = await world({ parentTopic: false });
    const { checkpoints, repository } = item.scenario;
    const parents: TopicManifest[] = [];
    for (let family = 0; family < 6; family += 1) {
      const parent = await storedTopic(item, `Parent ${family}`, `f${family}-parent`, {
        startPoint: checkpoints[3]!,
      });
      parents.push(parent);
      const first = await storedTopic(item, `Child ${family}a`, `f${family}-a`, {
        startPoint: checkpoints[1]!,
        parent: parent.id,
        target: { kind: "integration-branch" },
      });
      const second = await storedTopic(item, `Child ${family}b`, `f${family}-b`, {
        startPoint: checkpoints[2]!,
        parent: parent.id,
        target: { kind: "topic", topicId: first.id },
      });
      await item.topics.update(parent.id, (current) => ({
        ...current,
        integrationTarget: { kind: "topic", topicId: second.id },
      }));
    }
    // Two Topics that no observation can resolve: one pending child and one failed setup.
    await storedTopic(item, "Pending child", "pending-child", {
      startPoint: checkpoints[0]!,
      parent: parents[0]!.id,
      target: { kind: "integration-branch" },
      chainState: "pending",
      setupState: "provisioning",
    });
    await storedTopic(item, "Failed Topic", "failed-topic", {
      startPoint: checkpoints[0]!,
      setupState: "setup-failed",
    });
    const restarted = await restart(item, { idleProvisioner: true });
    expect(restarted.snapshot().topics).toHaveLength(20);
    // Startup reconciliation must settle before the refresh cost is measured alone.
    await settle(restarted);
    await item.runner.whenIdle();

    item.runner.clear();
    const startedAt = Date.now();
    await restarted.refreshIntegrationStatuses();
    const elapsedMs = Date.now() - startedAt;
    const statuses = Object.values(restarted.snapshot().integrationStatuses);

    expect(elapsedMs).toBeLessThan(REFRESH_BUDGET_MS);
    expect(item.runner.peakConcurrency).toBe(1);
    expect(item.runner.requests.every((request) => request.maxOutputBytes <= 64 * 1024)).toBeTrue();
    expect(item.runner.requests.every((request) => request.timeoutMs <= 30_000)).toBeTrue();
    expect(statuses).toHaveLength(20);
    expect(statuses.filter((status) => status.kind === "unknown")).toHaveLength(2);
    expect(statuses.every((status) => (status.detail?.length ?? 0) <= 200)).toBeTrue();
    expectNoGitMutation(item);
    restarted.stop();
    await repository.git("worktree", "prune");
  });

  test("migrates a legacy name family from real ancestry and keeps manifest backups", async () => {
    const item = await world({ parentTopic: false });
    const { checkpoints } = item.scenario;
    const parent = await storedTopic(item, "Parent", item.scenario.parentBranch, {
      target: { kind: "integration-branch" },
    });
    await storedTopic(item, "Parent > B", "feat-b", {
      startPoint: checkpoints[1]!,
      target: { kind: "integration-branch" },
    });
    await storedTopic(item, "Parent > C", "feat-c", {
      startPoint: checkpoints[2]!,
      target: { kind: "integration-branch" },
    });
    const restarted = await restart(item);
    expect(restarted.snapshot().legacyFamilies).toBe(1);

    const preview = await restarted.previewLegacyMigration();
    expect(preview.preview.families).toHaveLength(1);
    expect(preview.preview.families[0]?.children.map((child) => child.topicId)).toEqual([
      topicByName(item, "Parent > B").id,
      topicByName(item, "Parent > C").id,
    ]);
    // A preview writes nothing.
    expect((await item.topics.load(parent.id)).integrationTarget).toEqual({
      kind: "integration-branch",
    });

    const applied = await restarted.applyLegacyMigration("test-client", "migrate-1", [parent.id]);
    expect(applied.appliedParentTopicIds).toEqual([parent.id]);
    expect(applied.rolledBackParentTopicIds).toEqual([]);
    expect(chain(item)).toEqual(["integration", "Parent > B", "Parent > C", "Parent"]);

    const migrationId = applied.migrationId ?? "";
    const journal = JSON.parse(
      await readFile(item.paths.migrationJournal(migrationId), "utf8"),
    ) as Record<string, unknown>;
    expect(journal["state"]).toBe("settled");
    const backups = await readdir(join(item.paths.migrationDirectory(migrationId), "backup"));
    expect(backups.toSorted()).toEqual(
      restarted
        .snapshot()
        .topics.map((topic) => `${topic.id}.json`)
        .toSorted(),
    );
    const backup = JSON.parse(
      await readFile(item.paths.migrationBackup(migrationId, parent.id), "utf8"),
    ) as TopicManifest;
    expect(backup.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(backup.name).toBe("Parent");
    restarted.stop();
    expectNoGitMutation(item);
  });
});

interface StoredTopicOptions {
  /** Commit at which the local Branch is created. An absent Start Point keeps the Branch. */
  startPoint?: string;
  parent?: string;
  target?: TopicManifest["integrationTarget"];
  chainState?: TopicManifest["chainState"];
  /** Setup state of the stored Topic. It defaults to a finished, ready setup. */
  setupState?: TopicManifest["setup"]["state"];
}

/**
 * Writes one durable Topic with its real local Branch and Worktree directory, without the
 * daemon creation path. It builds large mixed Topic sets cheaply.
 */
async function storedTopic(
  item: World,
  name: string,
  branch: string,
  options: StoredTopicOptions = {},
): Promise<TopicManifest> {
  if (options.startPoint !== undefined) {
    await item.repository.createBranch(branch, options.startPoint);
  }
  const worktreePath = join(item.worktreeBase, branch);
  await mkdir(worktreePath, { recursive: true });
  const created = await item.topics.create(
    { name, branch, repository: REPOSITORY },
    options.parent === undefined
      ? undefined
      : {
          parentTopicId: options.parent,
          originCommit: options.startPoint ?? "",
          integrationTarget: options.target ?? { kind: "integration-branch" },
          chainState: options.chainState ?? "active",
        },
  );
  return item.topics.update(created.id, (current) => ({
    ...current,
    ...(options.parent === undefined && options.target !== undefined
      ? { integrationTarget: options.target }
      : {}),
    setup:
      options.setupState === undefined || options.setupState === "ready"
        ? {
            state: "ready",
            repositoryAvailable: true,
            worktreeCreated: true,
            setupCommandsRun: true,
          }
        : { ...current.setup, state: options.setupState },
    worktreePath,
  }));
}

/**
 * Waits until every background operation of a fresh daemon start has finished. It requires
 * several quiet samples, because startup work continues after one operation disappears.
 */
async function settle(service: TopicService): Promise<void> {
  let quiet = 0;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await Bun.sleep(5);
    quiet = service.snapshot().operations.length === 0 ? quiet + 1 : 0;
    if (quiet >= 20) return;
  }
  throw new Error("Service operations did not settle.");
}

/**
 * Stops the Service of one world and starts a fresh one over the same durable data. An idle
 * provisioner keeps the startup reconciliation out of a measurement.
 */
async function restart(
  item: World,
  options: { idleProvisioner?: boolean } = {},
): Promise<TopicService> {
  item.service.stop();
  const service = new TopicService({
    config: item.config,
    topics: item.topics,
    provisioner:
      options.idleProvisioner === true
        ? {
            provision: async (request) => ({
              status: "ready",
              topic: await item.topics.load(request.topicId),
            }),
          }
        : item.provisioner,
    integrationBranches: new IntegrationBranchResolver({
      config: item.config,
      runner: item.runner,
    }),
    integrationStatuses: new IntegrationStatusObserver({ runner: item.runner }),
    ancestry: new BranchAncestryReader({ runner: item.runner }),
    migrations: new LegacyMigrationJournal({ paths: item.paths }),
  });
  await service.start();
  item.service = service;
  return service;
}
