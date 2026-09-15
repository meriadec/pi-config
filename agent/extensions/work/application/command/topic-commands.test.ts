import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AbsolutePath,
  Branch,
  ClientId,
  DurableTopic,
  RequestId,
  type TopicId,
  type DurableTopic as DurableTopicValue,
} from "../../domain/index.ts";
import { makeKeyedConcurrency } from "../../infrastructure/concurrency/index.ts";
import {
  OperationRepository,
  TopicRepository,
  operationRepositoryLayer,
  topicRepositoryLayer,
} from "../../infrastructure/storage/index.ts";
import { makeOperationEngine } from "../operation/index.ts";
import { makeWorkState } from "../state/index.ts";
import { makeTopicCommands } from "./topic-commands.ts";

const paths = new Set<string>();
const CLIENT = ClientId.make("22222222-2222-4222-8222-222222222222");
const REQUEST = RequestId.make("33333333-3333-4333-8333-333333333333");
const MAIN = Branch.make("main");

const TOPIC: DurableTopicValue = Schema.decodeUnknownSync(DurableTopic)({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Before",
  branch: "feature/command",
  repository: "owner/repo",
  setup: {
    state: "ready",
    repositoryAvailable: true,
    worktreeCreated: true,
    setupCommandsRun: true,
    completedCommandCount: 0,
  },
  worktreePath: "/tmp/worktree",
  mainAgent: { sessionId: "session", sessionFile: null },
  partition: 0,
  integrationTarget: { kind: "integration-branch" },
  chainState: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

afterEach(async () => {
  await Promise.all([...paths].map((path) => rm(path, { recursive: true, force: true })));
  paths.clear();
});

async function database(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-topic-command-"));
  paths.add(directory);
  const path = join(directory, "work.db");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TopicRepository;
    }).pipe(Effect.scoped, Effect.provide(topicRepositoryLayer({ filename: path }))),
  );
  return path;
}

describe("Topic Atomic Commands", () => {
  test("normalizes rename and Note changes, publishes once, and replays without another write", async () => {
    const path = await database();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const topics = yield* TopicRepository;
        const operations = yield* OperationRepository;
        yield* topics.create(TOPIC);
        const state = yield* makeWorkState({
          daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
        });
        const engine = yield* makeOperationEngine({ repository: operations, state, workers: {} });
        const commands = makeTopicCommands({
          topics,
          operations: engine,
          state,
          concurrency: makeKeyedConcurrency(),
          ancestry: { readStable: () => Effect.succeed(() => true) },
          integrationBranches: {
            configured: () => Effect.succeed(MAIN),
            infer: () => Effect.succeed(MAIN),
          },
          repositoryPath: () => AbsolutePath.make("/tmp/repository"),
          now: Effect.succeed("2026-01-01T01:00:00.000Z"),
        });
        const request = {
          clientId: CLIENT,
          requestId: REQUEST,
          command: { _tag: "Rename" as const, topicId: TOPIC.id, name: "  After  " },
        };
        yield* commands.execute(request);
        yield* commands.execute(request);
        const renamed = yield* topics.get(TOPIC.id);
        const afterRenameRevision = (yield* state.snapshot).revision;
        yield* commands.execute({
          clientId: CLIENT,
          requestId: RequestId.make("44444444-4444-4444-8444-444444444444"),
          command: { _tag: "SetNote", topicId: TOPIC.id, note: "  remember this  " },
        });
        return {
          renamed,
          afterRenameRevision,
          noted: yield* topics.get(TOPIC.id),
          snapshot: yield* state.snapshot,
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            topicRepositoryLayer({ filename: path }),
            operationRepositoryLayer({ filename: path }),
          ),
        ),
      ),
    );

    expect(result.renamed.topic.name).toBe("After");
    expect(result.renamed.topic.branch).toBe(TOPIC.branch);
    expect(result.renamed.topic.repository).toBe(TOPIC.repository);
    expect(result.renamed.topic.worktreePath).toBe(TOPIC.worktreePath);
    expect(result.renamed.topic.integrationTarget).toEqual(TOPIC.integrationTarget);
    expect(result.renamed.topic.parentTopicId).toBe(TOPIC.parentTopicId);
    expect(result.renamed.topic.partition).toBe(TOPIC.partition);
    expect(result.renamed.revision).toBe(1);
    expect(result.afterRenameRevision).toBe(1);
    expect(result.noted.topic.note).toBe("remember this");
    expect(result.noted.revision).toBe(2);
    expect(result.snapshot.revision).toBe(2);
  });

  test("changes and removes a Parent Topic with atomic chain and Partition updates", async () => {
    const path = await database();
    const parent = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111101",
      name: "Old Parent",
      branch: "old-parent",
      integrationTarget: { kind: "topic", topicId: "11111111-1111-4111-8111-111111111102" },
    });
    const child = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111102",
      name: "Moving Child",
      branch: "moving-child",
      parentTopicId: parent.id,
      originCommit: "a".repeat(40),
      integrationTarget: { kind: "integration-branch" },
    });
    const adopter = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111103",
      name: "New Parent",
      branch: "new-parent",
      partition: 4,
      integrationTarget: { kind: "topic", topicId: "11111111-1111-4111-8111-111111111104" },
    });
    const earlier = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111104",
      name: "Earlier Child",
      branch: "earlier-child",
      partition: 4,
      parentTopicId: adopter.id,
      originCommit: "b".repeat(40),
      integrationTarget: { kind: "integration-branch" },
    });
    let ancestryReads = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const topics = yield* TopicRepository;
        const operations = yield* OperationRepository;
        for (const topic of [parent, child, adopter, earlier]) {
          const { parentTopicId: _parentTopicId, ...root } = topic;
          yield* topics.create({
            ...root,
            integrationTarget: { kind: "integration-branch" },
          });
        }
        yield* topics.applyChainPlan({
          edits: [
            { topicId: parent.id, integrationTarget: { kind: "topic", topicId: child.id } },
            { topicId: child.id, parentTopicId: parent.id },
            { topicId: adopter.id, integrationTarget: { kind: "topic", topicId: earlier.id } },
            { topicId: earlier.id, parentTopicId: adopter.id },
          ],
          expected: [parent, child, adopter, earlier].map((topic) => ({
            topicId: topic.id,
            revision: 0,
          })),
        });
        const state = yield* makeWorkState({
          daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
        });
        const engine = yield* makeOperationEngine({ repository: operations, state, workers: {} });
        const commands = makeTopicCommands({
          topics,
          operations: engine,
          state,
          concurrency: makeKeyedConcurrency(),
          ancestry: {
            readStable: () => {
              ancestryReads += 1;
              return Effect.succeed(
                (ancestor, descendant) =>
                  ancestor.kind === "topic" &&
                  descendant.kind === "topic" &&
                  ancestor.topicId === earlier.id &&
                  descendant.topicId === child.id,
              );
            },
          },
          integrationBranches: {
            configured: () => Effect.succeed(MAIN),
            infer: () => Effect.succeed(MAIN),
          },
          repositoryPath: () => AbsolutePath.make("/tmp/repository"),
        });
        yield* commands.execute({
          clientId: CLIENT,
          requestId: RequestId.make("33333333-3333-4333-8333-333333333301"),
          command: { _tag: "ChangeParent", topicId: child.id, parentTopicId: adopter.id },
        });
        const changed = {
          parent: yield* topics.get(parent.id),
          child: yield* topics.get(child.id),
          adopter: yield* topics.get(adopter.id),
          earlier: yield* topics.get(earlier.id),
        };
        yield* commands.execute({
          clientId: CLIENT,
          requestId: RequestId.make("33333333-3333-4333-8333-333333333302"),
          command: { _tag: "RemoveParent", topicId: child.id },
        });
        return {
          changed,
          removed: yield* topics.get(child.id),
          adopter: yield* topics.get(adopter.id),
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            topicRepositoryLayer({ filename: path }),
            operationRepositoryLayer({ filename: path }),
          ),
        ),
      ),
    );

    expect(result.changed.parent.topic.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(result.changed.child.topic).toMatchObject({
      parentTopicId: adopter.id,
      partition: 4,
      integrationTarget: { kind: "topic", topicId: earlier.id },
      chainState: "active",
      branch: child.branch,
    });
    expect(result.changed.adopter.topic.integrationTarget).toEqual({
      kind: "topic",
      topicId: child.id,
    });
    expect(result.changed.earlier.topic.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(result.removed.topic.parentTopicId).toBeUndefined();
    expect(result.removed.topic.partition).toBe(4);
    expect(result.removed.topic.integrationTarget).toEqual({ kind: "integration-branch" });
    expect(result.removed.topic.branch).toBe(child.branch);
    expect(result.adopter.topic.integrationTarget).toEqual({
      kind: "topic",
      topicId: earlier.id,
    });
    expect(ancestryReads).toBe(1);
  });

  test("moves and resets one family atomically with direct broken-edge confirmation", async () => {
    const path = await database();
    const parent = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111201",
      name: "Parent",
      branch: "parent",
      integrationTarget: { kind: "topic", topicId: "11111111-1111-4111-8111-111111111203" },
    });
    const first = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111202",
      name: "First",
      branch: "first",
      parentTopicId: parent.id,
      integrationTarget: { kind: "integration-branch" },
    });
    const second = Schema.decodeUnknownSync(DurableTopic)({
      ...TOPIC,
      id: "11111111-1111-4111-8111-111111111203",
      name: "Second",
      branch: "second",
      parentTopicId: parent.id,
      integrationTarget: { kind: "topic", topicId: first.id },
    });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const topics = yield* TopicRepository;
        const operations = yield* OperationRepository;
        for (const topic of [parent, first, second]) {
          const { parentTopicId: _parentTopicId, ...root } = topic;
          yield* topics.create({ ...root, integrationTarget: { kind: "integration-branch" } });
        }
        yield* topics.applyChainPlan({
          edits: [
            { topicId: first.id, parentTopicId: parent.id },
            {
              topicId: second.id,
              parentTopicId: parent.id,
              integrationTarget: { kind: "topic", topicId: first.id },
            },
            { topicId: parent.id, integrationTarget: { kind: "topic", topicId: second.id } },
          ],
          expected: [parent, first, second].map((topic) => ({ topicId: topic.id, revision: 0 })),
        });
        const state = yield* makeWorkState({
          daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
        });
        const engine = yield* makeOperationEngine({ repository: operations, state, workers: {} });
        const order = new Map<string, number>([
          [first.id, 0],
          [second.id, 1],
          [parent.id, 2],
        ]);
        const commands = makeTopicCommands({
          topics,
          operations: engine,
          state,
          concurrency: makeKeyedConcurrency(),
          ancestry: {
            readStable: () =>
              Effect.succeed((ancestor, descendant) => {
                if (ancestor.kind === "integration-branch") return true;
                if (descendant.kind === "integration-branch") return false;
                return order.get(ancestor.topicId)! <= order.get(descendant.topicId)!;
              }),
          },
          integrationBranches: {
            configured: () => Effect.succeed(MAIN),
            infer: () => Effect.succeed(MAIN),
          },
          repositoryPath: () => AbsolutePath.make("/tmp/repository"),
        });
        const move = {
          _tag: "MoveInChain" as const,
          topicId: first.id,
          target: { kind: "topic" as const, topicId: second.id },
        };
        const refused = yield* Effect.flip(
          commands.execute({
            clientId: CLIENT,
            requestId: RequestId.make("33333333-3333-4333-8333-333333333311"),
            command: move,
          }),
        );
        const unchanged = yield* topics.list;
        yield* commands.execute({
          clientId: CLIENT,
          requestId: RequestId.make("33333333-3333-4333-8333-333333333312"),
          command: { ...move, confirmed: true },
        });
        const moved = yield* topics.list;
        yield* commands.execute({
          clientId: CLIENT,
          requestId: RequestId.make("33333333-3333-4333-8333-333333333313"),
          command: { _tag: "ResetIntegrationTarget", topicId: parent.id },
        });
        return {
          refused,
          unchanged,
          moved,
          reset: yield* topics.list,
          snapshot: yield* state.snapshot,
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            topicRepositoryLayer({ filename: path }),
            operationRepositoryLayer({ filename: path }),
          ),
        ),
      ),
    );

    expect(result.refused).toMatchObject({ reason: "confirmation-required" });
    expect(result.refused.message).toContain("does not contain");
    const target = (values: typeof result.unchanged, id: TopicId) =>
      values.find(({ topic }) => topic.id === id)!.topic.integrationTarget;
    expect(target(result.unchanged, first.id)).toEqual({ kind: "integration-branch" });
    expect(target(result.unchanged, second.id)).toEqual({ kind: "topic", topicId: first.id });
    expect(target(result.moved, second.id)).toEqual({ kind: "integration-branch" });
    expect(target(result.moved, first.id)).toEqual({ kind: "topic", topicId: second.id });
    expect(target(result.reset, first.id)).toEqual({ kind: "integration-branch" });
    expect(target(result.reset, second.id)).toEqual({ kind: "topic", topicId: first.id });
    expect(result.reset.find(({ topic }) => topic.id === first.id)!.topic.branch).toBe(
      first.branch,
    );
    expect(result.snapshot.revision).toBe(2);
  });

  test("resets only the expected inferred repository state and refreshes safely", async () => {
    const path = await database();
    let configured: Branch | undefined;
    let refreshes = 0;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const topics = yield* TopicRepository;
        const operations = yield* OperationRepository;
        yield* topics.create(TOPIC);
        yield* topics.storeInferredIntegrationBranch(
          TOPIC.repository,
          MAIN,
          undefined,
          "2026-01-01T00:00:00.000Z",
        );
        const state = yield* makeWorkState({
          daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
        });
        const engine = yield* makeOperationEngine({ repository: operations, state, workers: {} });
        const commands = makeTopicCommands({
          topics,
          operations: engine,
          state,
          concurrency: makeKeyedConcurrency(),
          ancestry: { readStable: () => Effect.succeed(() => true) },
          integrationBranches: {
            configured: () => Effect.sync(() => configured),
            infer: () => Effect.succeed(MAIN),
          },
          repositoryPath: () => AbsolutePath.make("/tmp/repository"),
          refreshAfterIntegrationBranchReset: Effect.sync(() => {
            refreshes += 1;
          }),
        });
        const request = {
          clientId: CLIENT,
          requestId: RequestId.make("33333333-3333-4333-8333-333333333401"),
          repository: TOPIC.repository,
          expectedRevision: 0,
        };
        yield* commands.resetIntegrationBranch(request);
        yield* commands.resetIntegrationBranch(request);
        const afterReset = yield* topics.getInferredIntegrationBranch(TOPIC.repository);
        const newer = yield* topics.storeInferredIntegrationBranch(
          TOPIC.repository,
          Branch.make("next"),
          undefined,
          "2026-01-01T01:00:00.000Z",
        );
        const stale = yield* Effect.flip(
          commands.resetIntegrationBranch({
            ...request,
            requestId: RequestId.make("33333333-3333-4333-8333-333333333402"),
            expectedRevision: 7,
          }),
        );
        configured = MAIN;
        const explicit = yield* Effect.flip(
          commands.resetIntegrationBranch({
            ...request,
            requestId: RequestId.make("33333333-3333-4333-8333-333333333403"),
          }),
        );
        return {
          afterReset,
          newer,
          stale,
          explicit,
          retained: yield* topics.getInferredIntegrationBranch(TOPIC.repository),
          topic: yield* topics.get(TOPIC.id),
          snapshot: yield* state.snapshot,
        };
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            topicRepositoryLayer({ filename: path }),
            operationRepositoryLayer({ filename: path }),
          ),
        ),
      ),
    );

    expect(result.afterReset).toBeUndefined();
    expect(refreshes).toBe(1);
    expect(result.stale).toMatchObject({ reason: "conflict" });
    expect(result.explicit.message).toContain("explicit configured override");
    expect(result.retained).toEqual(result.newer);
    expect(result.topic.topic.branch).toBe(TOPIC.branch);
    expect(result.snapshot.durable.repositoryStates).toEqual([]);
  });
});
