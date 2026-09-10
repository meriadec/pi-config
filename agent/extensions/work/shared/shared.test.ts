import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_IDS,
  WorkDataError,
  createAffiliationStore,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
  parseActionPolicy,
  parseMainAgentState,
  normalizeTopicNote,
  parseIntegrationTarget,
  parseOriginCommit,
  parseRepository,
  pullRequestStatus,
  parseSetupState,
  parseTopicManifest,
  parseWorkConfig,
  resolveActionPolicy,
  resolveBaseCheckout,
  resolveIntegrationBranch,
} from "./index.ts";
import type { PullRequestRef, TopicManifest, WorkConfig } from "./index.ts";

const roots: string[] = [];
const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";
const ID_C = "123e4567-e89b-42d3-a456-426614174002";

async function temporaryPaths() {
  const root = await mkdtemp(join(tmpdir(), "pi-work-test-"));
  roots.push(root);
  return createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(): WorkConfig {
  return {
    version: 1,
    policies: {
      defaults: Object.fromEntries(
        ACTION_IDS.map((action) => [action, action === "topic.delete" ? "ask" : "allow"]),
      ),
      repositories: {},
      topics: {},
    },
    repositories: {},
  };
}

function manifest(id = ID_A): TopicManifest {
  return {
    version: 1,
    id,
    name: "VG-123",
    branch: "feat/VG-31025_tokenization",
    repository: "LedgerHQ/revault",
    setup: {
      state: "provisioning",
      repositoryAvailable: false,
      worktreeCreated: false,
      setupCommandsRun: false,
    },
    worktreePath: null,
    partition: 0,
    mainAgent: { sessionId: id, sessionFile: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("domain validation", () => {
  test("accepts valid config and rejects malformed or unsupported config", () => {
    expect(parseWorkConfig(config())).toEqual(config());
    const legacy = config();
    delete legacy.policies.defaults["agent.reset"];
    expect(parseWorkConfig(legacy).policies.defaults["agent.reset"]).toBe("ask");
    expect(() => parseWorkConfig({ version: 1, policies: [] })).toThrow(WorkDataError);
    expect(() => parseWorkConfig({ ...config(), version: 2 })).toThrow(
      "Unsupported configuration version",
    );
    expect(() =>
      parseWorkConfig({
        ...config(),
        policies: { ...config().policies, defaults: { "terminal.open": "sometimes" } },
      }),
    ).toThrow(WorkDataError);
  });

  test("validates action, setup, and main-agent states", () => {
    expect(parseActionPolicy("ask")).toBe("ask");
    expect(parseSetupState("ready")).toBe("ready");
    expect(parseMainAgentState("thinking-sub")).toBe("thinking-sub");
    expect(parseMainAgentState("tracking-pr")).toBe("tracking-pr");
    expect(parseMainAgentState("waiting-for-human")).toBe("waiting-for-human");
    expect(() => parseActionPolicy("prompt")).toThrow(WorkDataError);
    expect(() => parseSetupState("done")).toThrow(WorkDataError);
    expect(() => parseMainAgentState("thinking_sub")).toThrow(WorkDataError);
    expect(() => parseMainAgentState("running")).toThrow(WorkDataError);
  });

  test("shows approved for a formally approved pull request", () => {
    const approved: PullRequestRef = {
      number: 7,
      url: "https://github.com/LedgerHQ/revault/pull/7",
      state: "open",
      draft: false,
      ci: "passing",
      reviewPending: true,
      copilotReviewed: true,
      changesRequested: false,
      approved: true,
      unresolvedThreads: 0,
    };

    expect(pullRequestStatus(approved)).toBe("approved");
  });

  test("normalizes and validates Topic Notes", () => {
    expect(normalizeTopicNote("  waiting for Tom\r\nto answer  ")).toBe(
      "waiting for Tom to answer",
    );
    expect(normalizeTopicNote("   ")).toBeUndefined();
    expect(normalizeTopicNote("🙂".repeat(200))).toBe("🙂".repeat(200));
    expect(() => normalizeTopicNote("🙂".repeat(201))).toThrow(
      "Topic Note must be 200 characters or fewer.",
    );
    expect(() => normalizeTopicNote("bad\tcontrol")).toThrow(
      "Topic Note must not contain control characters.",
    );
  });

  test("accepts valid topics and rejects unsafe topic data", () => {
    expect(parseTopicManifest(manifest(), ID_A)).toEqual(manifest());
    expect(parseTopicManifest({ ...manifest(), note: "Waiting for Tom" })).toMatchObject({
      note: "Waiting for Tom",
    });
    expect(() => parseTopicManifest({ ...manifest(), note: "  not normalized  " })).toThrow(
      "Stored Topic Note must be non-empty and normalized.",
    );
    expect(() => parseTopicManifest({ ...manifest(), note: "" })).toThrow(
      "Stored Topic Note must be non-empty and normalized.",
    );
    expect(() => parseTopicManifest({ ...manifest(), version: 2 })).toThrow(
      "Unsupported topic manifest version",
    );
    expect(() => parseTopicManifest({ ...manifest(), worktreePath: 4 })).toThrow(WorkDataError);
    expect(() => parseTopicManifest({ ...manifest(), conversation: "secret" })).toThrow(
      "unknown field",
    );
    expect(() =>
      parseTopicManifest({ ...manifest(), branch: undefined, slug: "feat/legacy" }),
    ).toThrow("unknown field: slug");
    expect(() => parseTopicManifest(manifest(), ID_B)).toThrow("do not match");
  });

  test("converts legacy Focus values into the first two Partitions", () => {
    const { partition: _partition, ...legacy } = manifest();
    expect(parseTopicManifest({ ...legacy, focused: true }).partition).toBe(0);
    expect(parseTopicManifest({ ...legacy, focused: false }).partition).toBe(1);
    expect(parseTopicManifest(legacy).partition).toBe(0);
    expect(() => parseTopicManifest({ ...manifest(), focused: true })).toThrow(
      "must not contain both partition and focused",
    );
    expect(() => parseTopicManifest({ ...manifest(), partition: 0.5 })).toThrow(
      "partition must be a safe integer",
    );
  });

  test("defaults a legacy manifest without setupCommandsRun to already handled", () => {
    const legacy = manifest();
    const { setupCommandsRun: _run, ...setup } = legacy.setup;
    expect(parseTopicManifest({ ...legacy, setup }).setup.setupCommandsRun).toBe(true);
  });

  test("keeps Integration Chain data optional and validates it", () => {
    // A manifest predating Integration Chains stays a root Topic with an active chain state.
    const legacy = parseTopicManifest(manifest(), ID_A);
    expect(legacy.parentTopicId).toBeUndefined();
    expect(legacy.originCommit).toBeUndefined();
    expect(legacy.integrationTarget).toBeUndefined();
    expect(legacy.chainState).toBeUndefined();

    const child = {
      ...manifest(),
      parentTopicId: ID_B,
      originCommit: "a".repeat(40),
      integrationTarget: { kind: "topic", topicId: ID_C },
      chainState: "pending",
    };
    expect(parseTopicManifest(child, ID_A)).toEqual(child as TopicManifest);
    expect(
      parseTopicManifest({ ...manifest(), integrationTarget: { kind: "integration-branch" } })
        .integrationTarget,
    ).toEqual({ kind: "integration-branch" });

    for (const bad of [
      { parentTopicId: "not-an-id" },
      { parentTopicId: ID_A },
      { originCommit: "A".repeat(40) },
      { originCommit: "abc" },
      { originCommit: 42 },
      { integrationTarget: { kind: "branch", branch: "main" } },
      { integrationTarget: { kind: "topic", topicId: "not-an-id" } },
      { integrationTarget: { kind: "topic", topicId: ID_A } },
      { integrationTarget: { kind: "integration-branch", topicId: ID_B } },
      { integrationTarget: "main" },
      { chainState: "paused" },
      { chainState: true },
    ]) {
      expect(() => parseTopicManifest({ ...manifest(), ...bad }, ID_A)).toThrow(WorkDataError);
    }
  });

  test("parses Integration Targets and Origin Commits on their own", () => {
    expect(parseIntegrationTarget({ kind: "topic", topicId: ID_B })).toEqual({
      kind: "topic",
      topicId: ID_B,
    });
    expect(parseOriginCommit("b".repeat(40))).toBe("b".repeat(40));
    expect(() => parseIntegrationTarget(null)).toThrow(WorkDataError);
    expect(() => parseOriginCommit("b".repeat(39))).toThrow(WorkDataError);
  });

  test("parses and validates repository recipes", () => {
    const withRecipe = {
      ...config(),
      repositories: { "LedgerHQ/revault": { setupCommands: ["pnpm install", "pnpm build"] } },
    };
    expect(parseWorkConfig(withRecipe).repositories["LedgerHQ/revault"]?.setupCommands).toEqual([
      "pnpm install",
      "pnpm build",
    ]);
    expect(parseWorkConfig(config()).repositories).toEqual({});
    // The action is added with an allow default for configurations created before recipes.
    const legacy = config();
    delete legacy.policies.defaults["topic.run-setup"];
    expect(parseWorkConfig(legacy).policies.defaults["topic.run-setup"]).toBe("allow");
    for (const bad of [
      { "not-a-repo": { setupCommands: [] } },
      { "LedgerHQ/revault": { setupCommands: "pnpm install" } },
      { "LedgerHQ/revault": { setupCommands: [""] } },
      { "LedgerHQ/revault": { setupCommands: [42] } },
      { "LedgerHQ/revault": { basePath: "relative/path" } },
      { "LedgerHQ/revault": { basePath: 42 } },
      { "LedgerHQ/revault": { setupCommands: [], integrationBranch: "bad branch" } },
      { "LedgerHQ/revault": { setupCommands: [], integrationBranch: "" } },
      { "LedgerHQ/revault": { setupCommands: [], integrationBranch: 42 } },
    ]) {
      expect(() => parseWorkConfig({ ...config(), repositories: bad })).toThrow(WorkDataError);
    }
  });

  test("resolves a Base checkout location, honoring a per-repository basePath override", () => {
    const withOverride = parseWorkConfig({
      ...config(),
      workBase: "/home/user/work",
      repositories: {
        "LedgerHQ/revault": { setupCommands: [] },
        "meriadec/pi-config": { basePath: "/home/user/.pi" },
      },
    });
    // A declared basePath overrides the WORK_BASE/<name> default and needs no setupCommands.
    expect(withOverride.repositories["meriadec/pi-config"]?.basePath).toBe("/home/user/.pi");
    expect(resolveBaseCheckout(withOverride, "meriadec/pi-config")).toBe("/home/user/.pi");
    expect(resolveBaseCheckout(withOverride, "LedgerHQ/revault")).toBe("/home/user/work/revault");
    // Without a global workBase and without an override, the location is unknown.
    expect(resolveBaseCheckout({ repositories: {} }, "LedgerHQ/revault")).toBeUndefined();
    expect(
      resolveBaseCheckout(
        {
          repositories: { "meriadec/pi-config": { setupCommands: [], basePath: "/home/user/.pi" } },
        },
        "meriadec/pi-config",
      ),
    ).toBe("/home/user/.pi");
  });
});

describe("repository references and policies", () => {
  test("only parses exact owner/repo input", () => {
    expect(parseRepository("LedgerHQ/revault")).toEqual({
      owner: "LedgerHQ",
      name: "revault",
      fullName: "LedgerHQ/revault",
    });
    for (const invalid of [
      " LedgerHQ/revault",
      "LedgerHQ/revault ",
      "LedgerHQ/revault/extra",
      "https://github.com/LedgerHQ/revault",
      "owner/",
    ]) {
      expect(() => parseRepository(invalid)).toThrow(WorkDataError);
    }
  });

  test("reports topic, repository, and global policy sources", () => {
    const policies = config().policies;
    policies.repositories["LedgerHQ/revault"] = { "terminal.open": "ask" };
    policies.topics[ID_A] = { "terminal.open": "deny" };
    expect(
      resolveActionPolicy(policies, "terminal.open", {
        topicId: ID_A,
        repository: "LedgerHQ/revault",
      }),
    ).toEqual({
      policy: "deny",
      source: { level: "topic", key: ID_A },
    });
    expect(
      resolveActionPolicy(policies, "terminal.open", {
        topicId: ID_B,
        repository: "LedgerHQ/revault",
      }),
    ).toEqual({
      policy: "ask",
      source: { level: "repository", key: "LedgerHQ/revault" },
    });
    expect(
      resolveActionPolicy(policies, "terminal.open", { topicId: ID_B, repository: "other/repo" }),
    ).toEqual({
      policy: "allow",
      source: { level: "global" },
    });
  });
});

describe("configuration persistence", () => {
  test("uses injected paths and preserves unknown fields during update", async () => {
    const paths = await temporaryPaths();
    const raw = {
      ...config(),
      futureTopLevel: { enabled: true },
      policies: {
        ...config().policies,
        defaults: { ...config().policies.defaults, "future.action": "ask" },
        futurePolicySetting: "kept",
      },
    };
    await mkdir(join(paths.root), { recursive: true });
    await writeFile(paths.config, JSON.stringify(raw));

    const store = createConfigStore(paths);
    await store.update((current) => ({ ...current, workBase: "/test/work-base" }));

    const persisted = JSON.parse(await readFile(paths.config, "utf8")) as Record<string, unknown>;
    expect(persisted["futureTopLevel"]).toEqual({ enabled: true });
    const persistedPolicies = persisted["policies"] as Record<string, unknown>;
    expect(persistedPolicies["futurePolicySetting"]).toBe("kept");
    expect((persistedPolicies["defaults"] as Record<string, unknown>)["future.action"]).toBe("ask");
    expect(persisted["workBase"]).toBe("/test/work-base");
    expect(paths.config.startsWith(paths.root)).toBeTrue();
    expect(paths.socket.endsWith(join("runtime", "pi-workd.sock"))).toBeTrue();
  });

  test("writes private atomic config files", async () => {
    const paths = await temporaryPaths();
    await createConfigStore(paths).save(config());
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect(await createConfigStore(paths).load()).toEqual(config());
  });

  test("round-trips repository recipes", async () => {
    const paths = await temporaryPaths();
    const store = createConfigStore(paths);
    const withRecipe: WorkConfig = {
      ...config(),
      repositories: { "LedgerHQ/revault": { setupCommands: ["pnpm install", "pnpm build"] } },
    };
    await store.save(withRecipe);
    expect((await createConfigStore(paths).load())?.repositories).toEqual(withRecipe.repositories);
  });

  test("round-trips a repository Integration Branch and rejects an invalid one", async () => {
    const paths = await temporaryPaths();
    const store = createConfigStore(paths);
    const withBranch: WorkConfig = {
      ...config(),
      repositories: { "LedgerHQ/revault": { setupCommands: [], integrationBranch: "main" } },
    };
    await store.save(withBranch);

    const loaded = await createConfigStore(paths).load();
    expect(loaded?.repositories["LedgerHQ/revault"]?.integrationBranch).toBe("main");
    expect(resolveIntegrationBranch(loaded!, "LedgerHQ/revault")).toBe("main");
    expect(resolveIntegrationBranch(loaded!, "LedgerHQ/other")).toBeUndefined();

    const cleared = await store.update((current) => ({
      ...current,
      repositories: { "LedgerHQ/revault": { setupCommands: [] } },
    }));
    expect(cleared.repositories["LedgerHQ/revault"]?.integrationBranch).toBeUndefined();
    expect((await createConfigStore(paths).load())?.repositories).toEqual({
      "LedgerHQ/revault": { setupCommands: [] },
    });
  });
});

test("storage rejects a symlinked work directory", async () => {
  const paths = await temporaryPaths();
  const target = join(paths.root, "..", "redirected-work");
  await mkdir(join(paths.root, ".."), { recursive: true });
  await mkdir(target);
  await symlink(target, paths.root);
  await expect(createConfigStore(paths).save(config())).rejects.toThrow("unsafe storage");
});

describe("topic persistence", () => {
  test("creates atomically, updates the timestamp, and rejects duplicates", async () => {
    const paths = await temporaryPaths();
    const store = createTopicStore(paths, {
      generateId: () => ID_A,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const created = await store.create({
      name: "VG-123",
      branch: "same-branch",
      repository: "LedgerHQ/revault",
    });
    expect(created.id).toBe(ID_A);
    expect(created.worktreePath).toBeNull();
    expect(created.mainAgent.sessionId).toBe(ID_A);
    expect((await stat(paths.topicManifest(ID_A))).mode & 0o777).toBe(0o600);

    const updated = await store.update(ID_A, (topic) => ({ ...topic, name: "New name" }));
    expect(updated.updatedAt).toBe("2026-01-01T00:00:00.001Z");
    await expect(
      store.create({ name: "Duplicate", branch: "same-branch", repository: "LedgerHQ/revault" }),
    ).rejects.toMatchObject({
      code: "duplicate-topic",
    });
  });

  test("rewrites a legacy Focus manifest with durable Partition data", async () => {
    const paths = await temporaryPaths();
    await mkdir(paths.topicDirectory(ID_A), { recursive: true });
    const { partition: _partition, ...legacy } = manifest(ID_A);
    await writeFile(paths.topicManifest(ID_A), JSON.stringify({ ...legacy, focused: false }));

    expect((await createTopicStore(paths).load(ID_A)).partition).toBe(1);
    const stored = JSON.parse(await readFile(paths.topicManifest(ID_A), "utf8"));
    expect(stored.partition).toBe(1);
    expect(stored.focused).toBeUndefined();
  });

  test("allows the same branch in different repositories", async () => {
    const paths = await temporaryPaths();
    const ids = [ID_A, ID_B];
    const store = createTopicStore(paths, { generateId: () => ids.shift() ?? ID_C });
    await store.create({ name: "One", branch: "shared", repository: "owner/one" });
    await expect(
      store.create({ name: "Two", branch: "shared", repository: "owner/two" }),
    ).resolves.toMatchObject({ id: ID_B });
  });

  test("serializes concurrent updates to one topic", async () => {
    const paths = await temporaryPaths();
    const store = createTopicStore(paths, { generateId: () => ID_A });
    await store.create({ name: "0", branch: "counter", repository: "owner/repo" });
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update(ID_A, async (topic) => {
          await Bun.sleep(Math.random() * 3);
          return { ...topic, name: String(Number(topic.name) + 1) };
        }),
      ),
    );
    expect((await store.load(ID_A)).name).toBe("20");
  });

  test("hydrates valid topics while reporting corrupt and unsupported manifests", async () => {
    const paths = await temporaryPaths();
    await Promise.all(
      [ID_A, ID_B, ID_C].map((id) => mkdir(paths.topicDirectory(id), { recursive: true })),
    );
    await writeFile(paths.topicManifest(ID_A), JSON.stringify(manifest(ID_A)));
    await writeFile(paths.topicManifest(ID_B), "{broken json");
    await writeFile(paths.topicManifest(ID_C), JSON.stringify({ ...manifest(ID_C), version: 99 }));

    const hydration = await createTopicStore(paths).list();
    expect(hydration.topics.map((topic) => topic.id)).toEqual([ID_A]);
    expect(hydration.diagnostics).toHaveLength(2);
    expect(
      hydration.diagnostics.find((item) => item.topicId === ID_B)?.message.length,
    ).toBeLessThanOrEqual(200);
    expect(hydration.diagnostics.find((item) => item.topicId === ID_C)?.code).toBe(
      "unsupported-version",
    );
  });
});

describe("affiliation persistence", () => {
  test("round-trips valid entries and rejects malformed ones", async () => {
    const paths = await temporaryPaths();
    const store = createAffiliationStore(paths);
    expect(await store.load()).toEqual(new Map());

    await store.save(
      new Map([
        ["window-token", ID_A],
        ["", ID_B],
        ["bad-topic-token", "not-a-topic-id"],
      ]),
    );
    // Only the well-formed credential survives; empty tokens and non-topic ids drop.
    expect(await store.load()).toEqual(new Map([["window-token", ID_A]]));
  });

  test("ignores a corrupt affiliations file as an empty map", async () => {
    const paths = await temporaryPaths();
    await mkdir(join(paths.root), { recursive: true });
    await writeFile(paths.affiliations, "{not valid json");
    await expect(createAffiliationStore(paths).load()).rejects.toBeInstanceOf(WorkDataError);

    await writeFile(paths.affiliations, JSON.stringify({ version: 1, affiliations: [] }));
    expect(await createAffiliationStore(paths).load()).toEqual(new Map());
  });
});
