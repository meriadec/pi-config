import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  Branch,
  DurableTopic,
  FullCommitSha,
  Repository,
  TopicId,
  type DurableTopic as DurableTopicValue,
} from "../../domain/index.ts";
import { TopicRepository, topicRepositoryLayer, type TopicRepositoryService } from "./index.ts";

const PARENT = Schema.decodeUnknownSync(TopicId)("11111111-1111-4111-8111-111111111111");
const CHILD = Schema.decodeUnknownSync(TopicId)("22222222-2222-4222-8222-222222222222");
const OTHER = Schema.decodeUnknownSync(TopicId)("33333333-3333-4333-8333-333333333333");
const ORIGIN = Schema.decodeUnknownSync(FullCommitSha)("a".repeat(40));
const REPOSITORY = Schema.decodeUnknownSync(Repository)("acme/widgets");
const MAIN = Schema.decodeUnknownSync(Branch)("main");
const temporaryPaths = new Set<string>();

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-topic-storage-"));
  temporaryPaths.add(directory);
  return join(directory, "work.db");
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
      temporaryPaths.delete(path);
    }),
  );
});

function topic(
  id: typeof TopicId.Type,
  options: Partial<DurableTopicValue> = {},
): DurableTopicValue {
  return Schema.decodeUnknownSync(DurableTopic)({
    id,
    name: `Topic ${id.slice(0, 4)}`,
    branch: `topic-${id.slice(0, 4)}`,
    repository: REPOSITORY,
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 2,
    },
    worktreePath: `/tmp/${id}`,
    mainAgent: { sessionId: `session-${id}`, sessionFile: `/tmp/${id}.jsonl` },
    partition: 0,
    integrationTarget: { kind: "integration-branch" },
    chainState: "active",
    pullRequest: { number: 12 },
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:00:00.000Z",
    ...options,
  });
}

function run<A>(
  path: string,
  use: (repository: TopicRepositoryService) => Effect.Effect<A, unknown>,
  faultAt?: string,
): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* TopicRepository;
      return yield* use(repository);
    }).pipe(
      Effect.provide(
        topicRepositoryLayer({ filename: path, ...(faultAt === undefined ? {} : { faultAt }) }),
      ),
    ),
  );
}

async function family(path: string): Promise<void> {
  await run(path, (repository) =>
    Effect.gen(function* () {
      yield* repository.create(topic(PARENT));
      yield* repository.create(
        topic(CHILD, {
          parentTopicId: PARENT,
          originCommit: ORIGIN,
          integrationTarget: { kind: "integration-branch" },
          chainState: "pending",
        }),
      );
      yield* repository.applyChainPlan({
        edits: [
          { topicId: CHILD, chainState: "active" },
          { topicId: PARENT, integrationTarget: { kind: "topic", topicId: CHILD } },
        ],
        expected: [
          { topicId: CHILD, revision: 0 },
          { topicId: PARENT, revision: 0 },
        ],
      });
    }),
  );
}

describe("SQLite Topic repository", () => {
  test("migrates a private WAL database and round-trips every durable Topic field", async () => {
    const path = await databasePath();
    const original = topic(PARENT, { note: "Keep this", chainState: "pending" });
    const stored = await run(path, (repository) => repository.create(original));

    expect(stored).toEqual({ topic: original, revision: 0 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const database = new Database(path);
    expect(database.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    database.close();
  });

  test("stores the first pull request identity and keeps it across restart", async () => {
    const path = await databasePath();
    const { pullRequest: _pullRequest, ...withoutPullRequest } = topic(PARENT);
    await run(path, (repository) => repository.create(withoutPullRequest));
    const associated = await run(path, (repository) =>
      repository.associatePullRequest(PARENT, 42, "2026-06-01T10:01:00.000Z"),
    );
    expect(associated.topic.pullRequest).toEqual({ number: 42 });
    expect(associated.revision).toBe(1);

    const replaced = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repository = yield* TopicRepository;
        return yield* repository.associatePullRequest(PARENT, 43, "2026-06-01T10:02:00.000Z");
      }).pipe(Effect.provide(topicRepositoryLayer({ filename: path }))),
    );
    expect(Exit.isFailure(replaced)).toBe(true);
    expect((await run(path, (repository) => repository.get(PARENT))).topic.pullRequest).toEqual({
      number: 42,
    });
  });

  test("enforces unique Branches and rolls the complete failed create back", async () => {
    const path = await databasePath();
    await run(path, (repository) => repository.create(topic(PARENT)));
    const duplicate = topic(OTHER, { branch: topic(PARENT).branch });

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repository = yield* TopicRepository;
        return yield* repository.create(duplicate);
      }).pipe(Effect.provide(topicRepositoryLayer({ filename: path }))),
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect((await run(path, (repository) => repository.list)).map(({ topic }) => topic.id)).toEqual(
      [PARENT],
    );
  });

  test("rolls create back after each multi-row write checkpoint", async () => {
    for (const point of ["create:topic", "create:setup", "create:relationship", "create:agent"]) {
      const path = await databasePath();
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const repository = yield* TopicRepository;
          return yield* repository.create(topic(PARENT));
        }).pipe(Effect.provide(topicRepositoryLayer({ filename: path, faultAt: point }))),
      );
      expect(Exit.isFailure(exit), point).toBe(true);
      expect(await run(path, (repository) => repository.list), point).toEqual([]);
    }
  });

  test("rejects invalid one-level graphs and restores the prior row revision", async () => {
    const path = await databasePath();
    await family(path);
    const child = await run(path, (repository) => repository.get(CHILD));
    const invalid = {
      ...child.topic,
      repository: Schema.decodeUnknownSync(Repository)("acme/other"),
    };

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repository = yield* TopicRepository;
        return yield* repository.update(invalid, child.revision);
      }).pipe(Effect.provide(topicRepositoryLayer({ filename: path }))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await run(path, (repository) => repository.get(CHILD))).toEqual(child);
  });

  test("applies a complete Chain Plan atomically", async () => {
    const path = await databasePath();
    await family(path);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repository = yield* TopicRepository;
        return yield* repository.applyChainPlan({
          edits: [
            { topicId: CHILD, integrationTarget: { kind: "integration-branch" } },
            { topicId: PARENT, integrationTarget: { kind: "topic", topicId: CHILD } },
          ],
          expected: [
            { topicId: CHILD, revision: 1 },
            { topicId: PARENT, revision: 1 },
          ],
        });
      }).pipe(Effect.provide(topicRepositoryLayer({ filename: path, faultAt: `chain:${PARENT}` }))),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const values = await run(path, (repository) => repository.list);
    expect(values.every(({ revision }) => revision === 1)).toBe(true);
    expect(values.find(({ topic }) => topic.id === CHILD)?.topic.integrationTarget).toEqual({
      kind: "integration-branch",
    });
  });

  test("updates only a complete family Partition arrangement and rolls it back atomically", async () => {
    const path = await databasePath();
    await family(path);
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const repository = yield* TopicRepository;
        return yield* repository.updateFamilyPartition({
          family: [PARENT, CHILD],
          arrangement: [
            { topicId: PARENT, revision: 1, partition: 2 },
            { topicId: CHILD, revision: 1, partition: 2 },
          ],
        });
      }).pipe(
        Effect.provide(topicRepositoryLayer({ filename: path, faultAt: `partition:${CHILD}` })),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(
      (await run(path, (repository) => repository.list)).every(
        ({ topic, revision }) => topic.partition === 0 && revision === 1,
      ),
    ).toBe(true);
  });

  test("uses a nested savepoint and repairs the chain before non-cascading deletion", async () => {
    const path = await databasePath();
    await family(path);
    const remaining = await run(path, (repository) =>
      repository.deleteWithChainRepair(CHILD, 1, {
        edits: [{ topicId: PARENT, integrationTarget: { kind: "integration-branch" } }],
        expected: [{ topicId: PARENT, revision: 1 }],
      }),
    );

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.topic.id).toBe(PARENT);
    expect(remaining[0]?.topic.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(remaining[0]?.revision).toBe(2);
  });

  test("rolls deletion back at each dependent-row write point", async () => {
    for (const point of [
      "delete:operation-history",
      "delete:agent",
      "delete:setup",
      "delete:relationship",
      "delete:topic",
    ]) {
      const path = await databasePath();
      await run(path, (repository) => repository.create(topic(PARENT)));
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const repository = yield* TopicRepository;
          return yield* repository.deleteWithChainRepair(PARENT, 0, { edits: [], expected: [] });
        }).pipe(Effect.provide(topicRepositoryLayer({ filename: path, faultAt: point }))),
      );
      expect(Exit.isFailure(exit), point).toBe(true);
      expect(await run(path, (repository) => repository.get(PARENT)), point).toEqual({
        topic: topic(PARENT),
        revision: 0,
      });
    }
  });

  test("allows only one concurrent expected-revision update", async () => {
    const path = await databasePath();
    await run(path, (repository) => repository.create(topic(PARENT)));
    const exits = await run(path, (repository) =>
      Effect.all(
        [
          Effect.exit(
            repository.updateSetup(PARENT, { ...topic(PARENT).setup, completedCommandCount: 3 }, 0),
          ),
          Effect.exit(
            repository.updateSetup(PARENT, { ...topic(PARENT).setup, completedCommandCount: 4 }, 0),
          ),
        ],
        { concurrency: "unbounded" },
      ),
    );

    expect(exits.filter(Exit.isSuccess)).toHaveLength(1);
    expect(exits.filter(Exit.isFailure)).toHaveLength(1);
    expect((await run(path, (repository) => repository.get(PARENT))).revision).toBe(1);
  });

  test("stores inferred Integration Branch state with its own expected revision", async () => {
    const path = await databasePath();
    const first = await run(path, (repository) =>
      repository.storeInferredIntegrationBranch(
        REPOSITORY,
        MAIN,
        undefined,
        "2026-06-01T10:00:00.000Z",
      ),
    );
    expect(first.revision).toBe(0);

    const nextBranch = Schema.decodeUnknownSync(Branch)("develop");
    const second = await run(path, (repository) =>
      repository.storeInferredIntegrationBranch(
        REPOSITORY,
        nextBranch,
        0,
        "2026-06-01T11:00:00.000Z",
      ),
    );
    expect(second).toMatchObject({ inferredIntegrationBranch: nextBranch, revision: 1 });
    expect(
      await run(path, (repository) => repository.getInferredIntegrationBranch(REPOSITORY)),
    ).toEqual(second);
  });

  test("clears inferred Integration Branch state only at its expected revision", async () => {
    const path = await databasePath();
    await run(path, (repository) =>
      repository.storeInferredIntegrationBranch(
        REPOSITORY,
        MAIN,
        undefined,
        "2026-06-01T10:00:00.000Z",
      ),
    );
    await run(path, (repository) => repository.clearInferredIntegrationBranch(REPOSITORY, 0));
    expect(
      await run(path, (repository) => repository.getInferredIntegrationBranch(REPOSITORY)),
    ).toBeUndefined();
  });
});
