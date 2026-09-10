import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_IDS,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
  validateTopicGraph,
} from "../shared/index.ts";
import type {
  ActionId,
  ChainTopic,
  ConfigStore,
  TopicManifest,
  TopicStore,
  WorkConfig,
  WorkPaths,
} from "../shared/index.ts";
import type { AncestryRequest, BranchAncestryReader } from "./branch-ancestry.ts";
import type {
  IntegrationStatus,
  IntegrationStatusObserver,
  IntegrationStatusRequest,
} from "./integration-status.ts";
import type { ProvisionRequest, ProvisionResult } from "./provisioner.ts";
import { TopicService } from "./topic-service.ts";
import type { TopicServiceEvent, TopicMutationResult } from "./topic-service.ts";

const REPOSITORY = "LedgerHQ/revault";
const PARENT_HISTORY = ["c1", "c2", "c3", "c4"].map((label) => sha(label));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A stable full-SHA stand-in for one labelled commit. */
function sha(label: string): string {
  return label.padEnd(40, "0").replaceAll(/[^0-9a-f]/g, "0");
}

/** A committed local Git model: each Branch is the ordered history of its tip. */
class FakeAncestry {
  readonly branches = new Map<string, string[]>();
  /** Branches whose ancestry Git cannot answer, for example a missing local ref. */
  readonly unreadable = new Set<string>();

  contains(request: AncestryRequest): Promise<boolean | undefined> {
    const ancestor = this.history(request.ancestor);
    const descendant = this.history(request.descendant);
    if (ancestor === undefined || descendant === undefined) return Promise.resolve(undefined);
    const tip = ancestor.at(-1);
    return Promise.resolve(tip !== undefined && descendant.includes(tip));
  }

  private history(reference: AncestryRequest["ancestor"]): string[] | undefined {
    if ("commit" in reference)
      return PARENT_HISTORY.includes(reference.commit)
        ? historyUpTo(reference.commit)
        : [reference.commit];
    if (this.unreadable.has(reference.branch)) return undefined;
    return this.branches.get(reference.branch);
  }
}

/** The Parent Topic history up to and including one commit. */
function historyUpTo(commit: string): string[] {
  const index = PARENT_HISTORY.indexOf(commit);
  return index < 0 ? [commit] : PARENT_HISTORY.slice(0, index + 1);
}

class FakeProvisioner {
  readonly requests: ProvisionRequest[] = [];
  gate: Promise<void> | undefined;
  failBranches = new Set<string>();

  private readonly topics: TopicStore;
  private readonly ancestry: FakeAncestry;

  constructor(topics: TopicStore, ancestry: FakeAncestry) {
    this.topics = topics;
    this.ancestry = ancestry;
  }

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    this.requests.push(request);
    await this.gate;
    let topic = await this.topics.load(request.topicId);
    if (this.failBranches.has(topic.branch)) {
      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: { ...current.setup, state: "setup-failed", reason: "Setup failed safely." },
      }));
      return { status: "failed", reason: "Setup failed safely.", topic };
    }
    const origin = request.startPoint?.commit ?? topic.originCommit;
    if (origin !== undefined) this.ancestry.branches.set(topic.branch, historyUpTo(origin));
    topic = await this.topics.update(topic.id, (current) => ({
      ...current,
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
      },
      worktreePath: join(request.workBase, "wt-owned", topic.branch),
    }));
    return { status: "ready", topic };
  }
}

/**
 * Local Integration Status from the same committed model as the ancestry reader: a Topic
 * that contains its target tip is Current, and every other readable pair is Behind.
 */
class FakeIntegrationStatuses {
  private readonly ancestry: FakeAncestry;

  constructor(ancestry: FakeAncestry) {
    this.ancestry = ancestry;
  }

  async observe(request: IntegrationStatusRequest): Promise<IntegrationStatus> {
    const contains = await this.ancestry.contains({
      repositoryPath: request.repositoryPath,
      ancestor: { branch: request.targetBranch },
      descendant: { branch: request.branch },
    });
    if (contains === undefined) {
      return { kind: "unknown", target: request.targetBranch, detail: "Git cannot answer." };
    }
    return { kind: contains ? "current" : "behind", target: request.targetBranch };
  }
}

interface World {
  service: TopicService;
  topics: TopicStore;
  provisioner: FakeProvisioner;
  ancestry: FakeAncestry;
  config: ConfigStore;
  events: TopicServiceEvent[];
  parent: TopicManifest;
  paths: WorkPaths;
}

async function world(
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-child-"));
  roots.push(root);
  const workBase = join(root, "ledger");
  await mkdir(workBase, { recursive: true });
  const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
  const config = createConfigStore(paths);
  await config.save(configuration(workBase, overrides));
  const topics = createTopicStore(paths);
  const ancestry = new FakeAncestry();
  ancestry.branches.set("main", [sha("c1")]);
  ancestry.branches.set("feat-parent", PARENT_HISTORY);
  const provisioner = new FakeProvisioner(topics, ancestry);
  const service = new TopicService({
    config,
    topics,
    provisioner,
    ancestry: ancestry as unknown as BranchAncestryReader,
    integrationStatuses: new FakeIntegrationStatuses(
      ancestry,
    ) as unknown as IntegrationStatusObserver,
  });
  const events: TopicServiceEvent[] = [];
  service.subscribe((event) => events.push(event));
  await service.start();
  const created = await topics.create({
    name: "Parent",
    branch: "feat-parent",
    repository: REPOSITORY,
  });
  const parent = await topics.update(created.id, (current) => ({
    ...current,
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    integrationTarget: { kind: "integration-branch" },
  }));
  await service.refreshTopic(parent.id);
  return { service, topics, provisioner, ancestry, config, events, parent, paths };
}

function configuration(
  workBase: string,
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">>,
): WorkConfig {
  return {
    version: 1,
    workBase,
    policies: {
      defaults: Object.fromEntries(
        ACTION_IDS.map((action) => [action, overrides[action] ?? "allow"]),
      ),
      repositories: {},
      topics: {},
    },
    repositories: { [REPOSITORY]: { setupCommands: ["bun install"], integrationBranch: "main" } },
  };
}

let nextRequestId = 0;

function createChild(
  item: World,
  name: string,
  branch: string | undefined,
  commit: string,
): Promise<TopicMutationResult> {
  nextRequestId += 1;
  return item.service.createChild("test-client", `child-${nextRequestId}`, {
    parentTopicId: item.parent.id,
    name,
    ...(branch === undefined ? {} : { branch }),
    startPoint: { commit, sourceCheckout: "/checkouts/revault" },
  });
}

/** The Integration Chain of one family, from the Integration Branch to the Parent Topic. */
function chain(item: World): string[] {
  const topics = item.service.snapshot().topics;
  const names = new Map(topics.map((topic) => [topic.id, topic.name]));
  const active = topics.filter((topic) => topic.chainState !== "pending");
  const order: string[] = ["integration"];
  let cursor = "integration-branch";
  for (let step = 0; step < active.length; step += 1) {
    const next = active.find((topic) => {
      const target = topic.integrationTarget;
      if (target === undefined) return false;
      return cursor === "integration-branch"
        ? target.kind === "integration-branch"
        : target.kind === "topic" && target.topicId === cursor;
    });
    if (next === undefined) break;
    order.push(names.get(next.id) ?? next.id);
    cursor = next.id;
  }
  return order;
}

/**
 * The Integration Chain of exactly one family, from the Integration Branch to its Parent
 * Topic. Unlike `chain`, it stays exact while several root Topics exist.
 */
function familyChain(service: TopicService, parentTopicId: string): string[] {
  const topics = service.snapshot().topics;
  const parent = topics.find((topic) => topic.id === parentTopicId);
  if (parent === undefined) throw new Error(`No Parent Topic ${parentTopicId}.`);
  const members = [
    ...topics.filter(
      (topic) => topic.parentTopicId === parentTopicId && topic.chainState !== "pending",
    ),
    parent,
  ];
  const order: string[] = ["integration"];
  let cursor = "integration-branch";
  for (let step = 0; step < members.length; step += 1) {
    const next = members.find((topic) => {
      const target = topic.integrationTarget;
      if (target === undefined) return false;
      return cursor === "integration-branch"
        ? target.kind === "integration-branch"
        : target.kind === "topic" && target.topicId === cursor;
    });
    if (next === undefined) break;
    order.push(next.name);
    if (next.id === parent.id) break;
    cursor = next.id;
  }
  return order;
}

/** A second ready root Topic of the same repository, with its own committed history. */
async function rootTopic(
  item: World,
  name: string,
  branch: string,
  history: readonly string[],
): Promise<TopicManifest> {
  const created = await item.topics.create({ name, branch, repository: REPOSITORY });
  const stored = await item.topics.update(created.id, (current) => ({
    ...current,
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    integrationTarget: { kind: "integration-branch" },
  }));
  item.ancestry.branches.set(branch, [...history]);
  await item.service.refreshTopic(stored.id);
  return stored;
}

let nextChainRequestId = 0;

/** One chain maintenance request with a fresh request id. */
function chainRequestId(): string {
  nextChainRequestId += 1;
  return `chain-${nextChainRequestId}`;
}

/**
 * Creates the recorded Worktree directory of every Topic and re-observes, so local
 * Integration Status is observed instead of Unknown for a missing Worktree.
 */
async function materializeWorktrees(item: World): Promise<void> {
  for (const topic of item.service.snapshot().topics) {
    if (topic.worktreePath !== null) await mkdir(topic.worktreePath, { recursive: true });
  }
  await item.service.refreshWorktreePresence();
  await item.service.refreshIntegrationStatuses();
}

/** The chain-relevant view of every Topic the Service knows. */
function chainTopics(item: World): readonly ChainTopic[] {
  return item.service.snapshot().topics;
}

function topicByName(item: World, name: string): TopicManifest {
  const topic = item.service.snapshot().topics.find((candidate) => candidate.name === name);
  if (topic === undefined) throw new Error(`No Topic named ${name}.`);
  return topic;
}

describe("child Topic lifecycle", () => {
  test("builds the same Integration Chain in creation order and out of order", async () => {
    const ordered = await world();
    expect((await createChild(ordered, "B", "feat-b", PARENT_HISTORY[1]!)).status).toBe("ready");
    expect((await createChild(ordered, "C", "feat-c", PARENT_HISTORY[2]!)).status).toBe("ready");
    expect(chain(ordered)).toEqual(["integration", "B", "C", "Parent"]);

    const reversed = await world();
    expect((await createChild(reversed, "C", "feat-c", PARENT_HISTORY[2]!)).status).toBe("ready");
    expect((await createChild(reversed, "B", "feat-b", PARENT_HISTORY[1]!)).status).toBe("ready");
    expect(chain(reversed)).toEqual(["integration", "B", "C", "Parent"]);
    expect(validateTopicGraph(chainTopics(reversed))).toBeUndefined();
  });

  test("shows a provisioning child at its intended position while the chain stays valid", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    let release = (): void => undefined;
    item.provisioner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const pendingCreation = createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    for (let attempt = 0; attempt < 50 && item.service.snapshot().topics.length < 3; attempt += 1) {
      await Bun.sleep(1);
    }
    const pending = topicByName(item, "C");
    expect(pending.chainState).toBe("pending");
    expect(pending.setup.state).toBe("provisioning");
    expect(pending.originCommit).toBe(PARENT_HISTORY[2]!);
    // The intended position is stored, but the healthy chain is untouched while setup runs.
    expect(pending.integrationTarget).toEqual({
      kind: "topic",
      topicId: topicByName(item, "B").id,
    });
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();

    release();
    await pendingCreation;
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
    expect(topicByName(item, "C").chainState).toBe("active");
  });

  test("runs the same provisioning input as a normal fresh Topic", async () => {
    const item = await world();
    await createChild(item, "B", undefined, PARENT_HISTORY[1]!);
    const request = item.provisioner.requests[0]!;
    expect(request.recipe).toEqual(["bun install"]);
    expect(request.startPoint).toEqual({
      commit: PARENT_HISTORY[1]!,
      sourceCheckout: "/checkouts/revault",
    });
    // An omitted Branch uses the deterministic Topic-name conversion, with no other heuristic.
    expect(topicByName(item, "B").branch).toBe("b");
  });

  test("refuses every unsafe or ambiguous child request before it writes a Topic", async () => {
    const item = await world();
    await expect(createChild(item, "Foreign", "feat-x", sha("dead"))).rejects.toMatchObject({
      code: "invalid-start-point",
    });
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await expect(createChild(item, "Twin", "feat-twin", PARENT_HISTORY[1]!)).rejects.toMatchObject({
      code: "duplicate-origin-commit",
    });
    // A child Topic can never become a Parent Topic.
    const child = topicByName(item, "B");
    await expect(
      item.service.createChild("test-client", "nested", {
        parentTopicId: child.id,
        name: "Nested",
        branch: "feat-nested",
        startPoint: { commit: PARENT_HISTORY[2]!, sourceCheckout: "/checkouts/revault" },
      }),
    ).rejects.toMatchObject({ code: "nested-child" });
    await expect(
      createChild(item, "Same branch", "feat-b", PARENT_HISTORY[2]!),
    ).rejects.toMatchObject({ code: "topic-branch-conflict" });
    expect(item.service.snapshot().topics.map((topic) => topic.name)).toEqual(["Parent", "B"]);
  });

  test("keeps a ready child pending when the Parent Branch changed during setup", async () => {
    const item = await world();
    let release = (): void => undefined;
    item.provisioner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creation = createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    for (let attempt = 0; attempt < 50 && item.service.snapshot().topics.length < 2; attempt += 1) {
      await Bun.sleep(1);
    }
    // The Parent Topic Branch was rewritten while the child Worktree was prepared.
    item.ancestry.branches.set("feat-parent", [sha("r1"), sha("r2")]);
    release();

    const result = await creation;
    expect(result.status).toBe("ready");
    const pending = topicByName(item, "B");
    expect(pending.setup.state).toBe("ready");
    expect(pending.chainState).toBe("pending");
    expect(chain(item)).toEqual(["integration", "Parent"]);
    expect(item.service.snapshot().diagnostics).toEqual([
      {
        topicId: pending.id,
        code: "chain-pending",
        message: "The Parent Topic Branch no longer contains this child Branch.",
      },
    ]);

    // Retry Setup completes the insertion once ancestry is clear again, without new setup work.
    item.ancestry.branches.set("feat-parent", PARENT_HISTORY);
    const retried = await item.service.retry("test-client", "retry-1", pending.id);
    expect(retried.status).toBe("ready");
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    expect(item.service.snapshot().diagnostics).toEqual([]);
    expect(
      item.events.some(
        (event) => event.type === "diagnostic-cleared" && event.topicId === pending.id,
      ),
    ).toBeTrue();
  });

  test("preserves the healthy chain when child setup fails and finishes it on retry", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    item.provisioner.failBranches.add("feat-c");
    expect((await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!)).status).toBe("failed");
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    expect(topicByName(item, "C").chainState).toBe("pending");

    item.provisioner.failBranches.clear();
    await item.service.retry("test-client", "retry-failed", topicByName(item, "C").id);
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
  });

  test("serializes concurrent child creation and loses no rewiring", async () => {
    const item = await world();
    const [first, second] = await Promise.all([
      createChild(item, "B", "feat-b", PARENT_HISTORY[1]!),
      createChild(item, "C", "feat-c", PARENT_HISTORY[2]!),
    ]);
    expect([first.status, second.status]).toEqual(["ready", "ready"]);
    expect(chain(item)).toEqual(["integration", "B", "C", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("deletes a pending child without rewiring the active chain", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    item.provisioner.failBranches.add("feat-c");
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const pending = topicByName(item, "C");

    const requirement = await item.service.delete("test-client", "delete-1", pending.id);
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect((await item.service.confirm("test-client", "delete-2", requirement.token)).status).toBe(
      "deleted",
    );
    expect(chain(item)).toEqual(["integration", "B", "Parent"]);
    expect(topicByName(item, "B").integrationTarget).toEqual({ kind: "integration-branch" });
  });
  test("Focus and Unfocus move the complete family", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    const child = topicByName(item, "B");

    // Unfocus through the child; the Parent Topic follows, so the family never splits.
    expect((await item.service.setFocus("test-client", "focus-1", child.id, false)).status).toBe(
      "refocused",
    );
    expect(item.service.snapshot().topics.every((topic) => !topic.focused)).toBeTrue();

    // Focus through the Parent Topic; the child follows.
    expect(
      (await item.service.setFocus("test-client", "focus-2", item.parent.id, true)).status,
    ).toBe("refocused");
    expect(item.service.snapshot().topics.every((topic) => topic.focused)).toBeTrue();
  });
});

describe("chain maintenance actions", () => {
  test("changes the Parent Topic, reconnects the old chain, and adopts the new Focus", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const adopter = await rootTopic(item, "Adopter", "feat-adopter", [sha("c1")]);
    await item.service.setFocus("test-client", "focus-adopter", adopter.id, false);
    const child = topicByName(item, "B");

    const result = await item.service.changeParent(
      "test-client",
      chainRequestId(),
      child.id,
      adopter.id,
    );

    expect(result.status).toBe("chain-changed");
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "C", "Parent"]);
    expect(familyChain(item.service, adopter.id)).toEqual(["integration", "B", "Adopter"]);
    // The moved Topic joins the Focus of the family that adopts it.
    expect(topicByName(item, "B").focused).toBeFalse();
    expect(topicByName(item, "C").integrationTarget).toEqual({ kind: "integration-branch" });
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("removes the Parent Topic and makes the Topic a root against the Integration Branch", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const child = topicByName(item, "B");

    const result = await item.service.removeParent("test-client", chainRequestId(), child.id);

    expect(result.status).toBe("chain-changed");
    const promoted = topicByName(item, "B");
    expect(promoted.parentTopicId).toBeUndefined();
    expect(promoted.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "C", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("asks for confirmation on an explicit non-ancestor move and then shows Behind", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const moved = topicByName(item, "B");
    const target = topicByName(item, "C");

    const requirement = await item.service.moveInChain("test-client", chainRequestId(), moved.id, {
      kind: "topic",
      topicId: target.id,
    });
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect(requirement.action).toBe("topic.change-chain");
    expect(requirement.text).toContain("rebase");
    // Nothing is written before the confirmation.
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "C", "Parent"]);

    const applied = await item.service.confirm("test-client", chainRequestId(), requirement.token);

    expect(applied.status).toBe("chain-changed");
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "C", "B", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
    await materializeWorktrees(item);

    expect(item.service.snapshot().integrationStatuses[topicByName(item, "B").id]).toEqual({
      kind: "behind",
      target: "feat-c",
    });
  });

  test("applies an explicit move that current ancestry supports without confirmation", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const moved = topicByName(item, "B");

    const result = await item.service.moveInChain("test-client", chainRequestId(), moved.id, {
      kind: "integration-branch",
    });

    // B contains the Integration Branch and C contains B, so both edges stay supported.
    expect(result.status).toBe("chain-changed");
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "C", "Parent"]);
  });

  test("rejects every unsafe chain request and writes nothing", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const child = topicByName(item, "B");
    const sibling = topicByName(item, "C");
    const foreign = await item.topics.create({
      name: "Foreign",
      branch: "feat-foreign",
      repository: "LedgerHQ/other",
    });
    await item.topics.update(foreign.id, (current) => ({
      ...current,
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
      },
      integrationTarget: { kind: "integration-branch" },
    }));
    await item.service.refreshTopic(foreign.id);
    const before = item.service.snapshot().topics;

    await expect(
      item.service.changeParent("test-client", chainRequestId(), child.id, foreign.id),
    ).rejects.toMatchObject({ code: "cross-repository" });
    // A child Topic can never become a Parent Topic.
    await expect(
      item.service.changeParent("test-client", chainRequestId(), child.id, sibling.id),
    ).rejects.toMatchObject({ code: "nested-child" });
    await expect(
      item.service.changeParent("test-client", chainRequestId(), child.id, child.id),
    ).rejects.toMatchObject({ code: "not-allowed" });
    // A cycle: a child cannot integrate into itself or into its own Parent Topic.
    await expect(
      item.service.moveInChain("test-client", chainRequestId(), child.id, {
        kind: "topic",
        topicId: child.id,
      }),
    ).rejects.toMatchObject({ code: "not-allowed" });
    await expect(
      item.service.moveInChain("test-client", chainRequestId(), child.id, {
        kind: "topic",
        topicId: item.parent.id,
      }),
    ).rejects.toMatchObject({ code: "not-allowed" });
    await expect(
      item.service.moveInChain("test-client", chainRequestId(), child.id, {
        kind: "topic",
        topicId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "cross-repository" });
    await expect(
      item.service.removeParent("test-client", chainRequestId(), item.parent.id),
    ).rejects.toMatchObject({ code: "not-allowed" });
    await expect(
      item.service.resetIntegrationTargets("test-client", chainRequestId(), child.id),
    ).rejects.toMatchObject({ code: "not-allowed" });

    expect(item.service.snapshot().topics).toEqual(before);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("refuses a chain action on a child that is still pending", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    item.provisioner.failBranches.add("feat-c");
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const pending = topicByName(item, "C");

    await expect(
      item.service.removeParent("test-client", chainRequestId(), pending.id),
    ).rejects.toMatchObject({ code: "invalid-topic-state" });
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "Parent"]);
  });

  test("rebuilds a manually broken Integration Chain from current ancestry", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    // A manual manifest edit left the family with two children on the same chain source.
    await item.topics.update(topicByName(item, "C").id, (current) => ({
      ...current,
      integrationTarget: { kind: "integration-branch" },
    }));
    await item.service.refreshTopic(topicByName(item, "C").id);

    const result = await item.service.resetIntegrationTargets(
      "test-client",
      chainRequestId(),
      item.parent.id,
    );

    expect(result.status).toBe("chain-changed");
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "C", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("deletes an active child by reconnecting its successor and keeps other links", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    await createChild(item, "D", "feat-d", PARENT_HISTORY[3]!);
    const removed = topicByName(item, "C");

    const requirement = await item.service.delete("test-client", "delete-active", removed.id);
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");
    const deleted = await item.service.confirm("test-client", "delete-active-2", requirement.token);

    expect(deleted.status).toBe("deleted");
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "D", "Parent"]);
    expect(topicByName(item, "B").integrationTarget).toEqual({ kind: "integration-branch" });
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("refuses to delete a Parent Topic while children remain", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    const requirement = await item.service.delete("test-client", "delete-parent", item.parent.id);
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");

    await expect(
      item.service.confirm("test-client", "delete-parent-2", requirement.token),
    ).rejects.toMatchObject({ code: "not-allowed" });
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "B", "Parent"]);
  });

  test("deduplicates one request id and rejects a reused id with other arguments", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    const child = topicByName(item, "B");

    const first = await item.service.removeParent("test-client", "repeat", child.id);
    const repeated = await item.service.removeParent("test-client", "repeat", child.id);

    expect(first).toEqual(repeated);
    await expect(
      item.service.removeParent("test-client", "repeat", topicByName(item, "C").id),
    ).rejects.toMatchObject({ code: "request-id-conflict" });
  });

  test("serializes concurrent chain actions and loses no rewiring", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    await createChild(item, "D", "feat-d", PARENT_HISTORY[3]!);

    const [first, second] = await Promise.all([
      item.service.removeParent("test-client", chainRequestId(), topicByName(item, "B").id),
      item.service.removeParent("test-client", chainRequestId(), topicByName(item, "C").id),
    ]);

    expect([first.status, second.status]).toEqual(["chain-changed", "chain-changed"]);
    expect(familyChain(item.service, item.parent.id)).toEqual(["integration", "D", "Parent"]);
    expect(validateTopicGraph(chainTopics(item))).toBeUndefined();
  });

  test("keeps every chain change after a daemon restart", async () => {
    const item = await world();
    await createChild(item, "B", "feat-b", PARENT_HISTORY[1]!);
    await createChild(item, "C", "feat-c", PARENT_HISTORY[2]!);
    await item.service.removeParent("test-client", chainRequestId(), topicByName(item, "B").id);

    const restarted = new TopicService({
      config: item.config,
      topics: item.topics,
      provisioner: item.provisioner,
      ancestry: item.ancestry as unknown as BranchAncestryReader,
    });
    await restarted.start();
    restarted.stop();

    expect(familyChain(restarted, item.parent.id)).toEqual(["integration", "C", "Parent"]);
    expect(validateTopicGraph(restarted.snapshot().topics)).toBeUndefined();
  });
});
