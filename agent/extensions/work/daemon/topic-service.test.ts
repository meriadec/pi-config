import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkClient, WorkClientError } from "../client/client.ts";
import {
  ACTION_IDS,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
  resolveActionPolicy,
} from "../shared/index.ts";
import type {
  ActionId,
  TopicManifest,
  TopicStore,
  WorkConfig,
  WorkPaths,
  WorkPolicies,
} from "../shared/index.ts";
import type { ProvisionRequest, ProvisionResult } from "./provisioner.ts";
import type { PullRequestObserver } from "./pull-request-observer.ts";
import type { DesktopController } from "./desktop.ts";
import type { MainAgentManager } from "./main-agent.ts";
import { WorkDaemon } from "./server.ts";
import { TopicService } from "./topic-service.ts";

const roots: string[] = [];
const daemons: WorkDaemon[] = [];
const clients: WorkClient[] = [];

class FakeProvisioner {
  readonly calls: string[] = [];
  readonly recipes: (readonly string[])[] = [];
  readonly requests: ProvisionRequest[] = [];
  active = 0;
  maxActive = 0;
  failBranches = new Set<string>();
  gate: Promise<void> | undefined;

  constructor(privateTopics: TopicStore) {
    this.topics = privateTopics;
  }

  private readonly topics: TopicStore;

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    this.calls.push(request.topicId);
    this.recipes.push(request.recipe ?? []);
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await this.gate;
      let topic = await this.topics.load(request.topicId);
      if (request.startPoint !== undefined) {
        const worktreePolicy = resolveActionPolicy(request.policies, "topic.create-worktree", {
          topicId: topic.id,
          repository: topic.repository,
        });
        if (
          worktreePolicy.policy === "ask" &&
          !request.approvedActions?.has("topic.create-worktree")
        ) {
          return {
            status: "confirmation-required",
            action: "topic.create-worktree",
            policy: worktreePolicy,
            topic,
          };
        }
        if (worktreePolicy.policy === "deny") {
          topic = await failed(this.topics, topic, "Policy denied topic.create-worktree.");
          return {
            status: "denied",
            action: "topic.create-worktree",
            reason: "Policy denied topic.create-worktree.",
            topic,
          };
        }
      }
      const policy = resolveActionPolicy(request.policies, "repository.clone", {
        topicId: topic.id,
        repository: topic.repository,
      });
      if (policy.policy === "deny") {
        topic = await failed(this.topics, topic, "Policy denied repository.clone.");
        return {
          status: "denied",
          action: "repository.clone",
          reason: "Policy denied repository.clone.",
          topic,
        };
      }
      if (policy.policy === "ask" && !request.approvedActions?.has("repository.clone")) {
        return { status: "confirmation-required", action: "repository.clone", policy, topic };
      }
      if (this.failBranches.has(topic.branch)) {
        topic = await failed(this.topics, topic, "Setup failed safely.");
        return { status: "failed", reason: "Setup failed safely.", topic };
      }
      const worktreePath = join(request.workBase, "wt-owned", topic.branch);
      await mkdir(worktreePath, { recursive: true });
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
    } finally {
      this.active -= 1;
    }
  }
}

interface World {
  paths: WorkPaths;
  topics: TopicStore;
  provisioner: FakeProvisioner;
  daemon: WorkDaemon;
  client: WorkClient;
  service: TopicService;
  resetSessions: string[];
  setNow(value: number): void;
}

async function world(
  policyOverrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
  extras: {
    pullRequests?: PullRequestObserver;
    desktop?: DesktopController;
  } = {},
): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "work-topic-service-test-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  const workBase = join(root, "ledger");
  await mkdir(runtime, { recursive: true });
  await mkdir(workBase, { recursive: true });
  const paths = createWorkPaths({ home: join(root, "home"), runtime });
  const config = createConfigStore(paths);
  await config.save(configuration(workBase, policyOverrides));
  const topics = createTopicStore(paths);
  const provisioner = new FakeProvisioner(topics);
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const resetSessions: string[] = [];
  const mainAgent = {
    async reset(topic: TopicManifest) {
      const sessionId = "123e4567-e89b-42d3-a456-426614174099";
      resetSessions.push(sessionId);
      await topics.update(topic.id, (current) => ({
        ...current,
        mainAgent: { sessionId, sessionFile: null },
      }));
      return { kind: "launched" as const, workspace: 1, message: "Started a new Main Agent." };
    },
  } as MainAgentManager;
  const service = new TopicService({
    config,
    topics,
    provisioner,
    mainAgent,
    now: () => new Date(now),
    confirmationTtlMs: 100,
    ...(extras.pullRequests === undefined ? {} : { pullRequests: extras.pullRequests }),
    ...(extras.desktop === undefined ? {} : { desktop: extras.desktop }),
  });
  const daemon = new WorkDaemon({
    socketPath: paths.socket,
    runtimeDirectory: runtime,
    topicService: service,
  });
  await daemon.start();
  daemons.push(daemon);
  const client = await WorkClient.connect(paths.socket, { clientId: "test-client" });
  clients.push(client);
  return {
    paths,
    topics,
    provisioner,
    daemon,
    client,
    service,
    resetSessions,
    setNow(value) {
      now = value;
    },
  };
}

function configuration(
  workBase: string,
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
): WorkConfig {
  return {
    version: 1,
    workBase,
    policies: policies(overrides),
    repositories: {},
  };
}

function policies(
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
): WorkPolicies {
  return {
    defaults: Object.fromEntries(
      ACTION_IDS.map((action) => [action, overrides[action] ?? "allow"]),
    ),
    repositories: {},
    topics: {},
  };
}

async function failed(
  topics: TopicStore,
  topic: TopicManifest,
  reason: string,
): Promise<TopicManifest> {
  return topics.update(topic.id, (current) => ({
    ...current,
    setup: { ...current.setup, state: "setup-failed", reason },
  }));
}

async function stopWorld(item: World): Promise<void> {
  item.client.close();
  clients.splice(clients.indexOf(item.client), 1);
  await item.daemon.stop();
  daemons.splice(daemons.indexOf(item.daemon), 1);
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Topic Service daemon integration", () => {
  test("hydrates valid Topics and reports corrupt manifest diagnostics", async () => {
    const item = await world();
    await stopWorld(item);
    await item.topics.create({
      name: "Valid",
      branch: "feat-valid",
      repository: "LedgerHQ/revault",
    });
    const corruptId = "123e4567-e89b-42d3-a456-426614174099";
    await mkdir(item.paths.topicDirectory(corruptId), { recursive: true });
    await writeFile(item.paths.topicManifest(corruptId), "not json");

    const service = new TopicService({
      config: createConfigStore(item.paths),
      topics: item.topics,
      provisioner: item.provisioner,
    });
    const replacement = new WorkDaemon({
      socketPath: item.paths.socket,
      runtimeDirectory: dirname(item.paths.socket),
      topicService: service,
    });
    await replacement.start();
    daemons.push(replacement);
    const client = await WorkClient.connect(item.paths.socket);
    clients.push(client);
    const snapshot = await client.snapshot();
    expect(snapshot.topics).toHaveLength(1);
    expect(snapshot.diagnostics).toEqual([
      expect.objectContaining({ topicId: corruptId, code: "storage-error" }),
    ]);
  });

  test("reports an Orphan Topic when its Worktree directory disappears", async () => {
    const item = await world();
    const created = await item.client.createTopic({
      name: "Orphaned",
      branch: "feat-orphaned",
      repository: "LedgerHQ/revault",
    });
    if (created.status !== "ready") throw new Error("Expected a ready Topic.");
    expect((await item.client.snapshot()).orphanedTopicIds).toEqual([]);

    const events: Array<{
      type: "worktree-presence-changed";
      topicId: string;
      orphaned: boolean;
    }> = [];
    const unsubscribe = item.service.subscribe((event) => {
      if (event.type === "worktree-presence-changed") events.push(event);
    });
    await rm(created.topic.worktreePath!, { recursive: true });
    await item.service.refreshWorktreePresence();
    unsubscribe();

    expect((await item.client.snapshot()).orphanedTopicIds).toEqual([created.topic.id]);
    expect(events).toEqual([
      { type: "worktree-presence-changed", topicId: created.topic.id, orphaned: true },
    ]);
  });

  test("emits Topic added and setup events through ready", async () => {
    const item = await world();
    const events: string[] = [];
    await item.client.subscribe((event) => events.push(event.type));
    const result = await item.client.createTopic({
      name: "VG-123",
      branch: "feat-VG-123_example",
      repository: "LedgerHQ/revault",
    });
    expect(result.status).toBe("ready");
    expect(events).toEqual([
      "topic-added",
      "operation-changed",
      "setup-changed",
      "topic-changed",
      "operation-changed",
    ]);
    expect((await item.client.snapshot()).topics[0]?.setup.state).toBe("ready");
  });

  test("re-reads a manually edited Repository Recipe before provisioning a new Topic", async () => {
    const item = await world();
    // Simulate a manual edit of config.json after the daemon has started.
    await createConfigStore(item.paths).update((current) => ({
      ...current,
      repositories: {
        "LedgerHQ/revault": { setupCommands: ["pnpm install", "pnpm build"] },
      },
    }));

    const result = await item.client.createTopic({
      name: "Fresh",
      branch: "feat-fresh",
      repository: "LedgerHQ/revault",
    });

    expect(result.status).toBe("ready");
    expect(item.provisioner.recipes.at(-1)).toEqual(["pnpm install", "pnpm build"]);
  });

  test("discovers a pull request for a ready Topic and opens it in a browser", async () => {
    const openedUrls: string[] = [];
    const desktop = {
      async openPullRequest(url: string) {
        openedUrls.push(url);
        return { kind: "opened" as const, message: "Opened the pull request in a browser." };
      },
    } as unknown as DesktopController;
    const observedTargets: { knownPullRequestNumber?: number }[] = [];
    const observer = {
      async discover(target: {
        branch: string;
        worktreePath: string;
        knownPullRequestNumber?: number;
      }) {
        observedTargets.push(target);
        return {
          number: 42,
          url: `https://github.com/LedgerHQ/revault/pull/42?b=${target.branch}`,
          state: "open" as const,
          draft: false,
          ci: "failing" as const,
          reviewPending: false,
          copilotReviewed: false,
          changesRequested: false,
          approved: false,
          unresolvedThreads: 2,
        };
      },
    } as unknown as PullRequestObserver;
    const item = await world({}, { pullRequests: observer, desktop });

    const changed = new Promise<{ topicId: string; number: number }>((resolve) => {
      void item.client.subscribe((event) => {
        if (event.type === "pull-request-changed" && event.pullRequest !== null) {
          resolve({ topicId: event.topicId, number: event.pullRequest.number });
        }
      });
    });
    const ready = await item.client.createTopic({
      name: "Has PR",
      branch: "feat-has-pr",
      repository: "LedgerHQ/revault",
    });
    expect(ready.status).toBe("ready");
    const topicId = (ready as { topic: TopicManifest }).topic.id;
    expect(await changed).toEqual({ topicId, number: 42 });
    expect(observedTargets[0]?.knownPullRequestNumber).toBeUndefined();
    await item.service.refreshPullRequests();
    expect(observedTargets[1]?.knownPullRequestNumber).toBe(42);

    const snapshot = await item.client.snapshot();
    expect(snapshot.pullRequests?.[topicId]).toEqual({
      number: 42,
      url: "https://github.com/LedgerHQ/revault/pull/42?b=feat-has-pr",
      state: "open",
      draft: false,
      ci: "failing",
      reviewPending: false,
      copilotReviewed: false,
      changesRequested: false,
      approved: false,
      unresolvedThreads: 2,
    });

    const opened = await item.client.openPullRequest(topicId);
    expect(opened).toMatchObject({ kind: "opened" });
    expect(openedUrls).toEqual(["https://github.com/LedgerHQ/revault/pull/42?b=feat-has-pr"]);
  });

  test("reports unavailable when a Topic has no known pull request", async () => {
    const observer = {
      async discover() {
        return null;
      },
    } as unknown as PullRequestObserver;
    const item = await world({}, { pullRequests: observer });
    const ready = await item.client.createTopic({
      name: "No PR",
      branch: "feat-no-pr",
      repository: "LedgerHQ/revault",
    });
    const topicId = (ready as { topic: TopicManifest }).topic.id;
    const opened = await item.client.openPullRequest(topicId);
    expect(opened).toMatchObject({ kind: "unavailable" });
  });

  test("reports setup failure and retries it", async () => {
    const item = await world();
    item.provisioner.failBranches.add("feat-fail");
    const created = await item.client.createTopic({
      name: "Fail then retry",
      branch: "feat-fail",
      repository: "LedgerHQ/revault",
    });
    expect(created.status).toBe("failed");
    const topic = (await item.client.snapshot()).topics[0]!;
    item.provisioner.failBranches.clear();
    expect((await item.client.retryTopic(topic.id)).status).toBe("ready");
  });

  test("renames a Topic and keeps its branch and repository", async () => {
    const item = await world();
    const created = await item.client.createTopic({
      name: "Original name",
      branch: "feat-rename",
      repository: "LedgerHQ/revault",
    });
    expect(created.status).toBe("ready");
    const topic = (await item.client.snapshot()).topics[0]!;
    const renamed = await item.client.renameTopic(topic.id, "New name");
    expect(renamed.status).toBe("renamed");
    const stored = (await item.client.snapshot()).topics[0]!;
    expect(stored.name).toBe("New name");
    expect(stored.branch).toBe(topic.branch);
    expect(stored.repository).toBe(topic.repository);
  });

  test("sets, normalizes, and removes a Topic Note", async () => {
    const item = await world();
    const created = await item.client.createTopic({
      name: "Annotated",
      branch: "feat-note",
      repository: "LedgerHQ/revault",
    });
    if (created.status !== "ready") throw new Error("Expected a ready Topic.");

    const noted = await item.client.setTopicNote(
      created.topic.id,
      "  waiting for Tom\r\nto answer  ",
    );
    expect(noted).toMatchObject({
      status: "note-updated",
      topic: { note: "waiting for Tom to answer" },
    });
    expect(
      JSON.parse(await readFile(item.paths.topicManifest(created.topic.id), "utf8")),
    ).toMatchObject({
      note: "waiting for Tom to answer",
    });

    const removed = await item.client.setTopicNote(created.topic.id, "   ");
    expect(removed.status).toBe("note-updated");
    expect((removed as { topic: TopicManifest }).topic.note).toBeUndefined();
    expect(
      JSON.parse(await readFile(item.paths.topicManifest(created.topic.id), "utf8")),
    ).not.toHaveProperty("note");
  });

  test("rejects Topic Notes over 200 Unicode characters", async () => {
    const item = await world();
    const created = await item.client.createTopic({
      name: "Bounded Note",
      branch: "feat-bounded-note",
      repository: "LedgerHQ/revault",
    });
    if (created.status !== "ready") throw new Error("Expected a ready Topic.");
    await expect(
      item.client.setTopicNote(created.topic.id, "🙂".repeat(201)),
    ).rejects.toMatchObject({
      code: "invalid-topic-note",
    });
  });

  test("rejects an empty rename", async () => {
    const item = await world();
    await item.client.createTopic({
      name: "Keep name",
      branch: "feat-empty-rename",
      repository: "LedgerHQ/revault",
    });
    const topic = (await item.client.snapshot()).topics[0]!;
    await expect(item.client.renameTopic(topic.id, "   ")).rejects.toThrow();
  });

  test("sets and clears Topic Focus, persisting the durable flag", async () => {
    const item = await world();
    const created = await item.client.createTopic({
      name: "Hot topic",
      branch: "feat-focus",
      repository: "LedgerHQ/revault",
    });
    expect(created.status).toBe("ready");
    const topic = (await item.client.snapshot()).topics[0]!;
    // New Topics are born Focused.
    expect(topic.focused).toBe(true);

    const unfocused = await item.client.setTopicFocus(topic.id, false);
    expect(unfocused.status).toBe("refocused");
    expect((await item.client.snapshot()).topics[0]!.focused).toBe(false);

    const refocused = await item.client.setTopicFocus(topic.id, true);
    expect(refocused.status).toBe("refocused");
    expect((await item.client.snapshot()).topics[0]!.focused).toBe(true);
  });

  test("runs independent Topic creation concurrently", async () => {
    const item = await world();
    let release = (): void => undefined;
    item.provisioner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = item.client.createTopic({
      name: "One",
      branch: "feat-one",
      repository: "LedgerHQ/one",
    });
    const second = item.client.createTopic({
      name: "Two",
      branch: "feat-one",
      repository: "LedgerHQ/two",
    });
    await Bun.sleep(20);
    expect(item.provisioner.maxActive).toBe(2);
    expect((await item.client.snapshot()).operations).toHaveLength(2);
    release();
    expect(
      (await Promise.all([first, second])).every((result) => result.status === "ready"),
    ).toBeTrue();
  });

  test("rejects duplicate subjects and invalid input before provisioning", async () => {
    const item = await world();
    const input = { name: "One", branch: "feat-one", repository: "LedgerHQ/revault" };
    await item.client.createTopic(input);
    await expect(item.client.createTopic({ ...input, name: "Duplicate" })).rejects.toMatchObject({
      code: "topic-branch-conflict",
      details: { existingTopicName: "One" },
    });
    await expect(
      item.client.createTopic({
        name: "Bad",
        branch: "bad branch",
        repository: "LedgerHQ/revault",
      }),
    ).rejects.toBeInstanceOf(WorkClientError);
    expect(item.provisioner.calls).toHaveLength(1);
  });

  test("serializes concurrent creation for one repository and Branch", async () => {
    const item = await world();
    let release = (): void => undefined;
    item.provisioner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = { name: "First", branch: "same", repository: "LedgerHQ/revault" };
    const first = item.client.createTopic(input);
    const second = item.client.createTopic({ ...input, name: "Second" });
    const settled = Promise.allSettled([first, second]);
    await Bun.sleep(20);
    const [existing] = (await item.client.snapshot()).topics;
    expect(existing).toBeDefined();
    release();
    const results = await settled;
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: {
        code: "topic-branch-conflict",
        details: { existingTopicId: existing!.id, existingTopicName: existing!.name },
      },
    });
    expect(item.provisioner.calls).toHaveLength(1);
  });

  test("provisions with creation-only Start Point data and never stores it", async () => {
    const item = await world();
    const startPoint = { commit: "a".repeat(40), sourceCheckout: "/source/revault" };
    const result = await item.client.createTopic({
      name: "Exact",
      branch: "exact",
      repository: "LedgerHQ/revault",
      startPoint,
    });
    expect(result.status).toBe("ready");
    expect(item.provisioner.requests[0]?.startPoint).toEqual(startPoint);
    const [topic] = (await item.client.snapshot()).topics;
    expect(topic).toBeDefined();
    expect(topic).not.toHaveProperty("startPoint");
    expect(topic).not.toHaveProperty("sourceCheckout");
    expect(topic?.setup.state).toBe("ready");
  });

  test("preserves Start Point data through Worktree policy confirmation", async () => {
    const item = await world({ "topic.create-worktree": "ask" });
    const startPoint = { commit: "a".repeat(40), sourceCheckout: "/source/revault" };
    const pending = await item.client.createTopic({
      name: "Confirm exact",
      branch: "confirm-exact",
      repository: "LedgerHQ/revault",
      startPoint,
    });
    expect(pending.status).toBe("confirmation-required");
    if (pending.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect(pending.action).toBe("topic.create-worktree");
    expect((await item.client.confirm(pending.token)).status).toBe("ready");
    expect(item.provisioner.requests).toHaveLength(2);
    expect(item.provisioner.requests[1]?.startPoint).toEqual(startPoint);
    const [topic] = (await item.client.snapshot()).topics;
    expect(topic).not.toHaveProperty("startPoint");
    expect(topic).not.toHaveProperty("sourceCheckout");
  });

  test("deduplicates a repeated client request id without a second side effect", async () => {
    const item = await world();
    const input = { name: "One", branch: "feat-one", repository: "LedgerHQ/revault" };
    expect((await item.client.createTopic(input, "same-request")).status).toBe("ready");
    item.client.close();
    clients.splice(clients.indexOf(item.client), 1);
    const retried = await WorkClient.connect(item.paths.socket, { clientId: "test-client" });
    clients.push(retried);
    expect((await retried.createTopic(input, "same-request")).status).toBe("ready");
    await expect(
      retried.createTopic({ ...input, branch: "different" }, "same-request"),
    ).rejects.toMatchObject({ code: "request-id-conflict" });
    expect(item.provisioner.calls).toHaveLength(1);
    expect((await retried.snapshot()).topics).toHaveLength(1);
  });

  test("enforces allow, ask, expiry, rejection, and deny in the daemon", async () => {
    const allowed = await world();
    const ready = await allowed.client.createTopic({
      name: "Allowed",
      branch: "feat-allowed",
      repository: "LedgerHQ/allowed",
    });
    expect(ready.status).toBe("ready");

    const asked = await world({ "repository.clone": "ask" });
    const requirement = await asked.client.createTopic({
      name: "Asked",
      branch: "feat-asked",
      repository: "LedgerHQ/asked",
    });
    expect(requirement.status).toBe("confirmation-required");
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");
    const otherClient = await WorkClient.connect(asked.paths.socket, { clientId: "other-client" });
    clients.push(otherClient);
    await expect(otherClient.confirm(requirement.token)).rejects.toMatchObject({
      code: "invalid-confirmation",
    });
    expect((await asked.client.confirm(requirement.token)).status).toBe("ready");

    const changed = await world({ "repository.clone": "ask" });
    const changing = await changed.client.createTopic({
      name: "Policy changed",
      branch: "feat-policy-changed",
      repository: "LedgerHQ/changed",
    });
    if (changing.status !== "confirmation-required") throw new Error("Expected confirmation.");
    const changedConfig = createConfigStore(changed.paths);
    const current = (await changedConfig.load())!;
    await changedConfig.save({
      ...current,
      policies: policies({ "repository.clone": "deny" }),
    });
    expect((await changed.client.confirm(changing.token)).status).toBe("denied");

    const expired = await world({ "repository.clone": "ask" });
    const expiring = await expired.client.createTopic({
      name: "Expired",
      branch: "feat-expired",
      repository: "LedgerHQ/expired",
    });
    if (expiring.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expired.setNow(Date.parse(expiring.expiresAt) + 1);
    await expect(expired.client.confirm(expiring.token)).rejects.toMatchObject({
      code: "expired-confirmation",
    });

    const rejected = await world({ "repository.clone": "ask" });
    const rejecting = await rejected.client.createTopic({
      name: "Rejected",
      branch: "feat-rejected",
      repository: "LedgerHQ/rejected",
    });
    if (rejecting.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect((await rejected.client.reject(rejecting.token)).status).toBe("rejected");

    const denied = await world({ "repository.clone": "deny" });
    expect(
      (
        await denied.client.createTopic({
          name: "Denied",
          branch: "feat-denied",
          repository: "LedgerHQ/denied",
        })
      ).status,
    ).toBe("denied");
  });

  test("confirms Main Agent reset and starts a new empty session", async () => {
    const item = await world({ "agent.reset": "ask" });
    await item.client.createTopic({
      name: "Reset agent",
      branch: "feat-reset-agent",
      repository: "LedgerHQ/revault",
    });
    const topic = (await item.client.snapshot()).topics[0]!;

    const requirement = await item.client.resetMainAgent(topic.id);
    expect(requirement).toMatchObject({
      status: "confirmation-required",
      action: "agent.reset",
      text: expect.stringContaining("previous session file will be kept"),
    });
    if (!("status" in requirement) || requirement.status !== "confirmation-required") {
      throw new Error("Expected confirmation.");
    }
    expect(await item.client.confirm(requirement.token)).toMatchObject({ kind: "launched" });
    expect(item.resetSessions).toEqual(["123e4567-e89b-42d3-a456-426614174099"]);
    expect((await item.topics.load(topic.id)).mainAgent).toEqual({
      sessionId: "123e4567-e89b-42d3-a456-426614174099",
      sessionFile: null,
    });
  });

  test("deletes only the local manifest and gives an explicit confirmation warning", async () => {
    const item = await world({ "topic.delete": "ask" });
    await item.client.createTopic({
      name: "Delete",
      branch: "feat-delete",
      repository: "LedgerHQ/revault",
    });
    const topic = (await item.client.snapshot()).topics[0]!;
    const retained = join(item.paths.topicDirectory(topic.id), "retained-worktree-marker");
    await writeFile(retained, "keep");
    const requirement = await item.client.deleteTopic(topic.id);
    if (requirement.status !== "confirmation-required") throw new Error("Expected confirmation.");
    expect(requirement.text).toContain("will not be deleted");
    expect((await item.client.confirm(requirement.token)).status).toBe("deleted");
    await expect(readFile(retained, "utf8")).resolves.toBe("keep");
    await expect(readFile(item.paths.topicManifest(topic.id), "utf8")).rejects.toThrow();
    expect((await item.client.snapshot()).topics).toHaveLength(0);
  });

  test("queues restart reconciliation from every durable provisioning checkpoint", async () => {
    const item = await world();
    await stopWorld(item);
    const checkpoints = [
      { repositoryAvailable: false, worktreeCreated: false },
      { repositoryAvailable: true, worktreeCreated: false },
      { repositoryAvailable: true, worktreeCreated: true },
    ];
    for (const [index, checkpoint] of checkpoints.entries()) {
      const topic = await item.topics.create({
        name: `Checkpoint ${index}`,
        branch: `feat-checkpoint-${index}`,
        repository: `LedgerHQ/repo-${index}`,
      });
      await item.topics.update(topic.id, (current) => ({
        ...current,
        setup: { state: "provisioning", setupCommandsRun: false, ...checkpoint },
      }));
    }
    const provisioner = new FakeProvisioner(item.topics);
    const service = new TopicService({
      config: createConfigStore(item.paths),
      topics: item.topics,
      provisioner,
    });
    await service.start();
    for (
      let attempt = 0;
      attempt < 20 && !service.snapshot().topics.every((topic) => topic.setup.state === "ready");
      attempt++
    ) {
      await Bun.sleep(5);
    }
    expect(provisioner.calls).toHaveLength(3);
    expect(service.snapshot().topics.every((topic) => topic.setup.state === "ready")).toBeTrue();
  });
});
