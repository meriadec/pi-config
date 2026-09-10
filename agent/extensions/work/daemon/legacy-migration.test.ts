import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_IDS,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
  writeJsonAtomic,
} from "../shared/index.ts";
import type {
  ConfigStore,
  TopicManifest,
  TopicStore,
  WorkConfig,
  WorkPaths,
} from "../shared/index.ts";
import type { AncestryRequest, BranchAncestryReader } from "./branch-ancestry.ts";
import { LegacyMigrationJournal, migrationWrites } from "./legacy-migration.ts";
import type { ProvisionRequest, ProvisionResult } from "./provisioner.ts";
import { TopicService } from "./topic-service.ts";

const REPOSITORY = "LedgerHQ/revault";
const OTHER_REPOSITORY = "LedgerHQ/other";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A committed local Git model: each Branch is the ordered history of its tip. */
class FakeAncestry {
  readonly branches = new Map<string, string[]>();

  contains(request: AncestryRequest): Promise<boolean | undefined> {
    const ancestor = this.history(request.ancestor);
    const descendant = this.history(request.descendant);
    if (ancestor === undefined || descendant === undefined) return Promise.resolve(undefined);
    const tip = ancestor.at(-1);
    return Promise.resolve(tip !== undefined && descendant.includes(tip));
  }

  private history(reference: AncestryRequest["ancestor"]): string[] | undefined {
    if ("commit" in reference) return [reference.commit];
    return this.branches.get(reference.branch);
  }
}

/**
 * Counts provisioning requests. Migration is metadata only, so a preview and an apply must
 * never add one; the daemon's own idempotent startup check is the only source.
 */
class CountingProvisioner {
  readonly requests: ProvisionRequest[] = [];

  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    this.requests.push(request);
    return {
      status: "failed",
      reason: "Provisioning is not part of this test.",
    } as ProvisionResult;
  }
}

interface World {
  service: TopicService;
  topics: TopicStore;
  journal: LegacyMigrationJournal;
  paths: WorkPaths;
  config: ConfigStore;
  provisioner: CountingProvisioner;
  ancestry: FakeAncestry;
}

function configuration(workBase: string): WorkConfig {
  return {
    version: 1,
    workBase,
    policies: {
      defaults: Object.fromEntries(ACTION_IDS.map((action) => [action, "allow"])),
      repositories: {},
      topics: {},
    },
    repositories: {
      [REPOSITORY]: { setupCommands: [], integrationBranch: "main" },
      [OTHER_REPOSITORY]: { setupCommands: [], integrationBranch: "main" },
    },
  };
}

async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-migration-"));
  roots.push(root);
  const workBase = join(root, "base");
  await mkdir(join(workBase, "revault"), { recursive: true });
  await mkdir(join(workBase, "other"), { recursive: true });
  const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
  const config = createConfigStore(paths);
  await config.save(configuration(workBase));
  const topics = createTopicStore(paths);
  const ancestry = new FakeAncestry();
  const journal = new LegacyMigrationJournal({ paths });
  const provisioner = new CountingProvisioner();
  const service = new TopicService({
    config,
    topics,
    provisioner,
    ancestry: ancestry as unknown as BranchAncestryReader,
    migrations: journal,
  });
  return { service, topics, journal, paths, config, provisioner, ancestry };
}

/** Creates one ready Topic with the given legacy name and committed Branch history. */
async function readyTopic(
  item: World,
  name: string,
  branch: string,
  history: readonly string[],
  repository = REPOSITORY,
): Promise<TopicManifest> {
  const created = await item.topics.create({ name, branch, repository });
  item.ancestry.branches.set(branch, [...history]);
  return item.topics.update(created.id, (current) => ({
    ...current,
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    worktreePath: join("/tmp", branch),
  }));
}

/**
 * `Parent` with `Parent > foo` and `Parent > bar`: foo is contained in bar, bar in Parent.
 */
async function legacyWorld(): Promise<
  World & { parent: TopicManifest; foo: TopicManifest; bar: TopicManifest }
> {
  const item = await world();
  item.ancestry.branches.set("main", ["a"]);
  const foo = await readyTopic(item, "Parent > foo", "foo", ["a", "b"]);
  const bar = await readyTopic(item, "Parent > bar", "bar", ["a", "b", "c"]);
  const parent = await readyTopic(item, "Parent", "parent", ["a", "b", "c", "d"]);
  await item.service.start();
  return { ...item, parent, foo, bar };
}

describe("legacy migration preview", () => {
  test("proposes durable data and writes no manifest and no Git mutation", async () => {
    const item = await legacyWorld();
    const before = await item.topics.list();
    const provisions = item.provisioner.requests.length;
    const result = await item.service.previewLegacyMigration();
    expect(result.status).toBe("migration-preview");
    expect(result.preview.families).toHaveLength(1);
    const family = result.preview.families[0]!;
    expect(family.parentTopicId).toBe(item.parent.id);
    expect(family.children.map((child) => child.topicId)).toEqual([item.foo.id, item.bar.id]);
    expect(family.parentIntegrationTarget).toEqual({ kind: "topic", topicId: item.bar.id });
    const after = await item.topics.list();
    expect(after.topics).toEqual(before.topics);
    expect(item.provisioner.requests).toHaveLength(provisions);
  });

  test("detects legacy families at startup without changing them", async () => {
    const item = await legacyWorld();
    expect(item.service.snapshot().legacyFamilies).toBe(1);
    const topics = item.service.snapshot().topics;
    expect(topics.every((topic) => topic.parentTopicId === undefined)).toBeTrue();
  });

  test("keeps an ambiguous and a cross-repository match unchanged with bounded reasons", async () => {
    const item = await world();
    item.ancestry.branches.set("main", ["a"]);
    await readyTopic(item, "Parent", "parent-one", ["a", "b"]);
    await readyTopic(item, "Parent", "parent-two", ["a", "b"]);
    await readyTopic(item, "Parent > foo", "foo", ["a"]);
    await readyTopic(item, "Other", "other", ["a"], OTHER_REPOSITORY);
    await readyTopic(item, "Other > child", "other-child", ["a"]);
    await item.service.start();
    const { preview } = await item.service.previewLegacyMigration();
    expect(preview.families).toEqual([]);
    expect(preview.skipped.map((entry) => entry.code).toSorted()).toEqual([
      "ambiguous-name-match",
      "cross-repository",
    ]);
    expect(preview.skipped.every((entry) => entry.message.length <= 200)).toBeTrue();
  });
});

describe("legacy migration apply", () => {
  test("writes Parent Topic and Integration Target data only", async () => {
    const item = await legacyWorld();
    const provisions = item.provisioner.requests.length;
    const result = await item.service.applyLegacyMigration("client", "apply-1");
    expect(result.appliedParentTopicIds).toEqual([item.parent.id]);
    expect(result.rolledBackParentTopicIds).toEqual([]);
    const foo = await item.topics.load(item.foo.id);
    const bar = await item.topics.load(item.bar.id);
    const parent = await item.topics.load(item.parent.id);
    expect(foo.parentTopicId).toBe(item.parent.id);
    expect(foo.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(bar.integrationTarget).toEqual({ kind: "topic", topicId: item.foo.id });
    expect(parent.integrationTarget).toEqual({ kind: "topic", topicId: item.bar.id });
    // Names, Partitions, Branches, Worktrees, and setup state stay exactly as they were.
    expect([foo.name, bar.name, parent.name]).toEqual([item.foo.name, item.bar.name, "Parent"]);
    expect([foo.branch, bar.branch, parent.branch]).toEqual(["foo", "bar", "parent"]);
    expect([foo.worktreePath, parent.worktreePath]).toEqual([
      item.foo.worktreePath,
      item.parent.worktreePath,
    ]);
    expect(foo.partition).toBe(item.foo.partition);
    expect(parent.mainAgent).toEqual(item.parent.mainAgent);
    expect(item.provisioner.requests).toHaveLength(provisions);
    expect(item.service.snapshot().legacyFamilies).toBe(0);
  });

  test("migrates a safe family while an unrelated family stays ambiguous", async () => {
    const item = await legacyWorld();
    // The second family diverges: neither child tip contains the other.
    const left = await readyTopic(item, "Second > left", "left", ["a", "x"]);
    const right = await readyTopic(item, "Second > right", "right", ["a", "y"]);
    const second = await readyTopic(item, "Second", "second", ["a", "x", "y"]);
    await item.service.refreshTopic(left.id);
    await item.service.refreshTopic(right.id);
    await item.service.refreshTopic(second.id);
    const result = await item.service.applyLegacyMigration("client", "apply-2");
    expect(result.appliedParentTopicIds).toEqual([item.parent.id]);
    expect((await item.topics.load(left.id)).parentTopicId).toBeUndefined();
    expect((await item.topics.load(second.id)).integrationTarget).toBeUndefined();
    expect(result.skipped.map((entry) => entry.topicId)).toContain(second.id);
  });

  test("applies only the approved families", async () => {
    const item = await legacyWorld();
    const result = await item.service.applyLegacyMigration("client", "apply-3", []);
    expect(result.appliedParentTopicIds).toEqual([]);
    expect(result.migrationId).toBeNull();
    expect((await item.topics.load(item.foo.id)).parentTopicId).toBeUndefined();
  });
});

describe("legacy migration recovery", () => {
  test("rolls a family back after an injected failure at every write point", async () => {
    for (let failAt = 0; failAt < 3; failAt += 1) {
      const item = await legacyWorld();
      const { preview } = await item.service.previewLegacyMigration();
      const manifests = new Map<string, TopicManifest>();
      for (const topic of [item.foo, item.bar, item.parent]) {
        manifests.set(topic.id, await item.topics.load(topic.id));
      }
      const writes = migrationWrites(preview.families, manifests);
      let written = 0;
      const result = await item.journal.run(writes, manifests, async (manifest) => {
        if (written === failAt) {
          written += 1;
          throw new Error("Injected write failure.");
        }
        written += 1;
        return item.topics.update(manifest.id, () => manifest);
      });
      expect(result.appliedParentTopicIds).toEqual([]);
      expect(result.rolledBackParentTopicIds).toEqual([item.parent.id]);
      for (const [topicId, original] of manifests) {
        const current = await item.topics.load(topicId);
        expect(current.parentTopicId).toBe(original.parentTopicId as string);
        expect(current.integrationTarget).toEqual(original.integrationTarget!);
        expect(current.name).toBe(original.name);
      }
      const journal = await item.journal.read(result.migrationId);
      expect(journal?.state).toBe("settled");
    }
  });

  test("restores an interrupted run at daemon start and keeps completed families", async () => {
    const item = await legacyWorld();
    const other = await readyTopic(item, "Second", "second", ["a", "b", "c", "d"]);
    const child = await readyTopic(item, "Second > child", "second-child", ["a", "b"]);
    await item.service.refreshTopic(other.id);
    await item.service.refreshTopic(child.id);
    const { preview } = await item.service.previewLegacyMigration();
    expect(preview.families).toHaveLength(2);
    const manifests = new Map<string, TopicManifest>();
    for (const topicId of [item.foo.id, item.bar.id, item.parent.id, other.id, child.id]) {
      manifests.set(topicId, await item.topics.load(topicId));
    }
    const writes = migrationWrites(preview.families, manifests);
    const complete = writes[0]!;
    const interrupted = writes[1]!;
    await item.journal.run([complete], manifests, (manifest) =>
      item.topics.update(manifest.id, () => manifest),
    );

    // The on-disk state of a crash: backups and an applying journal, plus a partial write.
    const crashId = "run-interrupted";
    for (const manifest of interrupted.manifests) {
      await writeJsonAtomic(
        item.paths.migrationBackup(crashId, manifest.id),
        manifests.get(manifest.id),
      );
    }
    await writeJsonAtomic(item.paths.migrationJournal(crashId), {
      version: 1,
      id: crashId,
      createdAt: new Date().toISOString(),
      state: "applying",
      families: [
        {
          parentTopicId: interrupted.parentTopicId,
          topicIds: interrupted.manifests.map((manifest) => manifest.id),
        },
      ],
      completed: [],
      rolledBack: [],
    });
    const half = interrupted.manifests[0]!;
    await item.topics.update(half.id, () => half);

    const restored = new TopicService({
      config: item.config,
      topics: item.topics,
      provisioner: item.provisioner,
      migrations: item.journal,
    });
    await restored.start();
    const byId = new Map(restored.snapshot().topics.map((topic) => [topic.id, topic]));
    expect(byId.get(complete.parentTopicId)?.integrationTarget).toBeDefined();
    expect(byId.get(interrupted.parentTopicId)?.integrationTarget).toBeUndefined();
    for (const manifest of interrupted.manifests) {
      expect(byId.get(manifest.id)?.parentTopicId).toBeUndefined();
      expect(byId.get(manifest.id)?.integrationTarget).toBeUndefined();
      expect(byId.get(manifest.id)?.name).toBe(manifests.get(manifest.id)!.name);
    }
    expect((await item.journal.read(crashId))?.state).toBe("settled");
  });
});

describe("legacy migration storage", () => {
  test("keeps backups private and prunes settled runs", async () => {
    const item = await legacyWorld();
    const result = await item.service.applyLegacyMigration("client", "apply-4");
    const migrationId = result.migrationId!;
    const directory = item.paths.migrationDirectory(migrationId);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(item.paths.migrationJournal(migrationId))).mode & 0o777).toBe(0o600);
    const backup = item.paths.migrationBackup(migrationId, item.foo.id);
    expect((await stat(backup)).mode & 0o777).toBe(0o600);

    const journal = new LegacyMigrationJournal({ paths: item.paths, retention: 1 });
    for (const id of ["run-a", "run-b"]) {
      await new LegacyMigrationJournal({ paths: item.paths, generateId: () => id }).run(
        [],
        new Map(),
        async (manifest) => manifest,
      );
    }
    await journal.run([], new Map(), async (manifest) => manifest);
    const kept = await readdir(item.paths.migrations);
    expect(kept).toHaveLength(1);
  });
});
