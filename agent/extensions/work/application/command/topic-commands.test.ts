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
    expect(result.renamed.revision).toBe(1);
    expect(result.afterRenameRevision).toBe(1);
    expect(result.noted.topic.note).toBe("remember this");
    expect(result.noted.revision).toBe(2);
    expect(result.snapshot.revision).toBe(2);
  });
});
