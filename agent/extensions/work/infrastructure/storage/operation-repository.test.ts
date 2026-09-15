import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import {
  ClientId,
  DurableTopic,
  OperationId,
  PrivateLocalCapability,
  RequestId,
  TopicId,
} from "../../domain/index.ts";
import {
  OperationRepository,
  operationRepositoryLayer,
  TopicRepository,
  topicRepositoryLayer,
  type OperationRepositoryService,
} from "./index.ts";

const OPERATION = Schema.decodeUnknownSync(OperationId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const SECOND_OPERATION = Schema.decodeUnknownSync(OperationId)(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
);
const CLIENT = Schema.decodeUnknownSync(ClientId)("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
const REQUEST = Schema.decodeUnknownSync(RequestId)("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
const SECOND_REQUEST = Schema.decodeUnknownSync(RequestId)("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
const TOPIC = Schema.decodeUnknownSync(TopicId)("ffffffff-ffff-4fff-8fff-ffffffffffff");
const TOKEN_TEXT = "safe-fixed-confirmation-value";
const TOKEN = Schema.decodeUnknownSync(PrivateLocalCapability)(TOKEN_TEXT);
const OTHER_TOKEN = Schema.decodeUnknownSync(PrivateLocalCapability)(
  "safe-fixed-registration-value",
);
const paths = new Set<string>();

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-operation-storage-"));
  paths.add(directory);
  return join(directory, "work.db");
}
afterEach(async () => {
  await Promise.all([...paths].map((path) => rm(path, { recursive: true, force: true })));
  paths.clear();
});

function run<A>(
  path: string,
  use: (repository: OperationRepositoryService) => Effect.Effect<A, unknown>,
  faultAt?: string,
) {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* OperationRepository);
    }).pipe(
      Effect.provide(
        operationRepositoryLayer({ filename: path, ...(faultAt === undefined ? {} : { faultAt }) }),
      ),
    ),
  );
}
const input = { version: 1 as const, kind: "topic-create", value: { name: "Stored input" } };
const result = { version: 1 as const, status: "succeeded" as const, value: { topicId: "done" } };
function claim(id = OPERATION, requestId = REQUEST, now = "2026-06-01T00:00:00.000Z") {
  return (repository: OperationRepositoryService) =>
    repository.claim({
      id,
      clientId: CLIENT,
      requestId,
      fingerprint: `create:${requestId}`,
      operationInput: input,
      phase: "accepted",
      now,
    });
}

async function createTopic(path: string) {
  const topic = Schema.decodeUnknownSync(DurableTopic)({
    id: TOPIC,
    name: "Capability Topic",
    branch: "capability-topic",
    repository: "acme/widgets",
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: "/tmp/capability-topic",
    mainAgent: { sessionId: "session", sessionFile: null },
    partition: 0,
    integrationTarget: { kind: "integration-branch" },
    chainState: "active",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* (yield* TopicRepository).create(topic);
    }).pipe(Effect.provide(topicRepositoryLayer({ filename: path }))),
  );
}

describe("SQLite operation repository", () => {
  test("replays one claim and terminal result after a repository restart", async () => {
    const path = await databasePath();
    expect((await run(path, claim())).claimed).toBe(true);
    const running = await run(path, (repository) =>
      repository.transition({
        id: OPERATION,
        expectedState: "accepted",
        expectedRevision: 0,
        state: "running",
        phase: "setup",
        now: "2026-06-01T00:01:00.000Z",
      }),
    );
    await run(path, (repository) =>
      repository.transition({
        id: OPERATION,
        expectedState: "running",
        expectedRevision: running.revision,
        state: "succeeded",
        phase: "complete",
        now: "2026-06-01T00:02:00.000Z",
        result,
      }),
    );

    const replay = await run(path, claim());
    expect(replay.claimed).toBe(false);
    expect(replay.operation.result).toEqual(result);
  });

  test("returns a typed collision and rejects invalid state or revision transitions", async () => {
    const path = await databasePath();
    await run(path, claim());
    const collision = await Effect.runPromiseExit(
      runEffect(path, (repository) =>
        repository.claim({
          id: SECOND_OPERATION,
          clientId: CLIENT,
          requestId: REQUEST,
          fingerprint: "different",
          operationInput: input,
          phase: "accepted",
          now: "2026-06-01T00:00:00.000Z",
        }),
      ),
    );
    expect(Exit.isFailure(collision)).toBe(true);
    if (Exit.isFailure(collision)) expect(String(collision.cause)).toContain("OperationFailure");

    const invalid = await Effect.runPromiseExit(
      runEffect(path, (repository) =>
        repository.transition({
          id: OPERATION,
          expectedState: "accepted",
          expectedRevision: 0,
          state: "succeeded",
          phase: "complete",
          now: "2026-06-01T00:01:00.000Z",
          result,
        }),
      ),
    );
    expect(Exit.isFailure(invalid)).toBe(true);
    expect((await run(path, (repository) => repository.get(OPERATION))).state).toBe("accepted");
  });

  test("distinguishes a completed Setup checkpoint from an interrupted running command", async () => {
    const path = await databasePath();
    await run(path, claim());
    await run(path, (repository) =>
      repository.transition({
        id: OPERATION,
        expectedState: "accepted",
        expectedRevision: 0,
        state: "running",
        phase: "setup",
        now: "2026-06-01T00:01:00.000Z",
      }),
    );
    const first = await run(path, (repository) =>
      repository.startSetupStep(OPERATION, 0, 1, "2026-06-01T00:02:00.000Z"),
    );
    await run(path, (repository) =>
      repository.completeSetupStep(OPERATION, 0, first.revision, "2026-06-01T00:03:00.000Z"),
    );
    await run(path, (repository) =>
      repository.startSetupStep(OPERATION, 1, 2, "2026-06-01T00:04:00.000Z"),
    );

    expect(
      await run(path, (repository) =>
        repository.recoverInterruptedSetup("2026-06-01T00:05:00.000Z"),
      ),
    ).toEqual([OPERATION]);
    expect(
      (await run(path, (repository) => repository.listSteps(OPERATION))).map((step) => step.state),
    ).toEqual(["completed", "interrupted"]);
    expect((await run(path, (repository) => repository.get(OPERATION))).state).toBe(
      "setup-interrupted",
    );
  });

  test("stores only capability hashes and consumes confirmation and registration once", async () => {
    const path = await databasePath();
    await createTopic(path);
    await run(path, (repository) =>
      repository.createConfirmation({
        capability: TOKEN,
        action: "topic.delete",
        expiresAt: "2026-06-01T00:10:00.000Z",
      }),
    );
    await run(path, (repository) =>
      repository.storeCapability({
        capability: OTHER_TOKEN,
        kind: "registration",
        topicId: TOPIC,
        expiresAt: "2026-06-01T00:10:00.000Z",
        now: "2026-06-01T00:00:00.000Z",
      }),
    );
    expect(
      await run(path, (repository) =>
        repository.consumeConfirmation(TOKEN, "2026-06-01T00:01:00.000Z"),
      ),
    ).toBe("consumed");
    expect(
      await run(path, (repository) =>
        repository.consumeConfirmation(TOKEN, "2026-06-01T00:02:00.000Z"),
      ),
    ).toBe("invalid");
    expect(
      await run(path, (repository) =>
        repository.consumeRegistration(OTHER_TOKEN, TOPIC, "2026-06-01T00:01:00.000Z"),
      ),
    ).toBe(true);
    expect(
      await run(path, (repository) =>
        repository.consumeRegistration(OTHER_TOKEN, TOPIC, "2026-06-01T00:02:00.000Z"),
      ),
    ).toBe(false);
    const database = new Database(path);
    const dump = JSON.stringify([
      ...database.query("SELECT * FROM confirmations").all(),
      ...database.query("SELECT * FROM private_capabilities").all(),
    ]);
    database.close();
    expect(dump).not.toContain(TOKEN_TEXT);
    expect(dump).not.toContain("safe-fixed-registration-value");
    expect(dump).toMatch(/[0-9a-f]{64}/);
  });

  test("expires confirmations and prunes old or excess terminal results but keeps active operations", async () => {
    const path = await databasePath();
    await run(path, (repository) =>
      repository.createConfirmation({
        capability: TOKEN,
        action: "topic.delete",
        expiresAt: "2026-06-01T00:01:00.000Z",
      }),
    );
    expect(
      await run(path, (repository) =>
        repository.consumeConfirmation(TOKEN, "2026-06-01T00:01:00.000Z"),
      ),
    ).toBe("expired");
    await run(path, claim(OPERATION, REQUEST, "2026-04-01T00:00:00.000Z"));
    await run(path, (repository) =>
      repository.transition({
        id: OPERATION,
        expectedState: "accepted",
        expectedRevision: 0,
        state: "running",
        phase: "run",
        now: "2026-04-01T00:01:00.000Z",
      }),
    );
    await run(path, (repository) =>
      repository.transition({
        id: OPERATION,
        expectedState: "running",
        expectedRevision: 1,
        state: "succeeded",
        phase: "done",
        now: "2026-04-01T00:02:00.000Z",
        result,
      }),
    );
    await run(path, claim(SECOND_OPERATION, SECOND_REQUEST, "2026-06-01T00:00:00.000Z"));
    await run(path, (repository) =>
      repository.storeCommandResult({
        clientId: CLIENT,
        requestId: REQUEST,
        fingerprint: "old",
        result,
        now: "2026-04-01T00:00:00.000Z",
      }),
    );
    const pruned = await run(path, (repository) =>
      repository.pruneTerminalResults("2026-06-01T00:00:00.000Z", 1),
    );
    expect(pruned).toEqual({ operations: 1, commands: 1 });
    expect((await run(path, (repository) => repository.get(SECOND_OPERATION))).state).toBe(
      "accepted",
    );
  });

  test("rolls back injected transaction failures", async () => {
    const path = await databasePath();
    const exit = await Effect.runPromiseExit(runEffect(path, claim(), "claim:insert"));
    expect(Exit.isFailure(exit)).toBe(true);
    const database = new Database(path);
    expect(database.query("SELECT count(*) AS count FROM durable_operations").get()).toEqual({
      count: 0,
    });
    database.close();
  });
});

function runEffect<A>(
  path: string,
  use: (repository: OperationRepositoryService) => Effect.Effect<A, unknown>,
  faultAt?: string,
) {
  return Effect.gen(function* () {
    return yield* use(yield* OperationRepository);
  }).pipe(
    Effect.provide(
      operationRepositoryLayer({ filename: path, ...(faultAt === undefined ? {} : { faultAt }) }),
    ),
  );
}
