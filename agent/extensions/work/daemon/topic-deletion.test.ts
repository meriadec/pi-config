import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ClientId,
  DurableTopic,
  OperationId,
  RequestId,
  type ActionPolicy,
  type DurableTopic as DurableTopicValue,
} from "../domain/index.ts";
import { ProcessPlatformLive } from "../infrastructure/process/index.ts";
import type { WorkRpcApplication } from "../infrastructure/rpc/index.ts";
import {
  OperationRepository,
  TopicRepository,
  operationRepositoryLayer,
  topicRepositoryLayer,
} from "../infrastructure/storage/index.ts";
import { createWorkPaths } from "../shared/paths.ts";
import { makeProductionWorkApplication } from "./production-application.ts";

const roots = new Set<string>();
const CLIENT = ClientId.make("70000000-0000-4000-8000-000000000001");
const TOPIC: DurableTopicValue = Schema.decodeUnknownSync(DurableTopic)({
  id: "70000000-0000-4000-8000-000000000002",
  name: "Delete me",
  branch: "feature/delete-me",
  repository: "owner/repo",
  setup: {
    state: "ready",
    repositoryAvailable: true,
    worktreeCreated: true,
    setupCommandsRun: true,
    completedCommandCount: 0,
  },
  worktreePath: "/tmp/delete-me",
  mainAgent: { sessionId: "delete-session", sessionFile: null },
  partition: 0,
  integrationTarget: { kind: "integration-branch" },
  chainState: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function fixture(policy: ActionPolicy, withOperationHistory = false) {
  const parent = await mkdtemp(join(process.cwd(), ".scratch/work-delete-policy-test-"));
  roots.add(parent);
  const root = join(parent, "work");
  const runtime = join(parent, "runtime");
  await privateDirectory(root);
  await privateDirectory(runtime);
  const config = join(root, "config.json");
  await privateFile(config, {
    version: 2,
    policies: {
      defaults: {
        "repository.clone": "allow",
        "topic.create-worktree": "allow",
        "topic.run-setup": "allow",
        "terminal.open": "allow",
        "agent.open": "allow",
        "agent.reset": "allow",
        "topic.delete": policy,
      },
      repositories: {},
      topics: {},
    },
    repositories: {},
  });
  const database = join(root, "work.db");
  await Effect.runPromise(
    Effect.gen(function* () {
      const topics = yield* TopicRepository;
      yield* topics.create(TOPIC);
    }).pipe(Effect.scoped, Effect.provide(topicRepositoryLayer({ filename: database }))),
  );
  if (withOperationHistory) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const operations = yield* OperationRepository;
        const claimed = yield* operations.claim({
          id: OperationId.make("70000000-0000-4000-8000-000000000098"),
          clientId: CLIENT,
          requestId: RequestId.make("70000000-0000-4000-8000-000000000098"),
          fingerprint: "terminal.open:delete-me",
          topicId: TOPIC.id,
          phase: "authorizing",
          operationInput: { version: 1, kind: "terminal.open", value: {} },
          now: "2026-01-01T00:01:00.000Z",
        });
        const running = yield* operations.transition({
          id: claimed.operation.id,
          expectedState: "accepted",
          expectedRevision: claimed.operation.revision,
          state: "running",
          phase: "running",
          now: "2026-01-01T00:01:01.000Z",
        });
        yield* operations.transition({
          id: running.id,
          expectedState: "running",
          expectedRevision: running.revision,
          state: "succeeded",
          phase: "succeeded",
          result: {
            version: 1,
            status: "succeeded",
            value: { message: "Opened Topic terminal." },
          },
          now: "2026-01-01T00:01:02.000Z",
        });
      }).pipe(Effect.scoped, Effect.provide(operationRepositoryLayer({ filename: database }))),
    );
  }
  const paths = createWorkPaths({ home: parent, runtime });
  return {
    config,
    paths,
    lease: {
      runtimeDirectory: runtime,
      socketPath: paths.socket,
      lockPath: join(runtime, "pi-workd.lock"),
    },
  };
}

function request(number: number) {
  return {
    clientId: CLIENT,
    requestId: RequestId.make(`70000000-0000-4000-8000-${number.toString().padStart(12, "0")}`),
    fingerprint: `topic.delete:${TOPIC.id}`,
    topicId: TOPIC.id,
    input: { version: 1 as const, kind: "topic.delete", value: {} },
    phase: "authorizing",
  };
}

async function runApplication<A>(
  policy: ActionPolicy,
  use: (application: WorkRpcApplication, config: string) => Effect.Effect<A, unknown>,
  withOperationHistory = false,
): Promise<A> {
  const value = await fixture(policy, withOperationHistory);
  return Effect.runPromise(
    Effect.scoped(
      makeProductionWorkApplication(value.paths, value.lease).pipe(
        Effect.flatMap((application) => use(application, value.config)),
      ),
    ).pipe(Effect.provide(ProcessPlatformLive), Effect.provide(BunFileSystem.layer)),
  );
}

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe("policy-aware Topic deletion", () => {
  test("allows deletion without confirmation and replays the accepted request safely", async () => {
    const result = await runApplication("allow", (application) =>
      Effect.gen(function* () {
        const bypass = yield* Effect.exit(
          application.commands.execute({
            clientId: CLIENT,
            requestId: RequestId.make("70000000-0000-4000-8000-000000000099"),
            command: { _tag: "Delete", topicId: TOPIC.id },
          }),
        );
        const before = yield* application.state.snapshot;
        const first = yield* application.operations.start(request(1));
        const completed = yield* application.operations.await(first.id);
        const replay = yield* application.operations.start(request(1));
        return { bypass, before, completed, replay, snapshot: yield* application.state.snapshot };
      }),
    );

    expect(result.bypass._tag).toBe("Failure");
    expect(result.before.durable.topics).toHaveLength(1);
    expect(result.completed.result?.status).toBe("succeeded");
    expect(result.replay.id).toBe(result.completed.id);
    expect(result.snapshot.durable.topics).toEqual([]);
  });

  test("deletes a Topic that has retained operation history", async () => {
    const result = await runApplication(
      "allow",
      (application) =>
        Effect.gen(function* () {
          const handle = yield* application.operations.start(request(6));
          const completed = yield* application.operations.await(handle.id);
          return { completed, snapshot: yield* application.state.snapshot };
        }),
      true,
    );

    expect(result.completed.result?.status).toBe("succeeded");
    expect(result.snapshot.durable.topics).toEqual([]);
    const retained = result.snapshot.durable.operations.find(
      (operation) => operation.id === "70000000-0000-4000-8000-000000000098",
    );
    expect(retained).toBeDefined();
  });

  test("asks directly, rejects without a change, then consumes approval once", async () => {
    const result = await runApplication("ask", (application) =>
      Effect.gen(function* () {
        const rejectedHandle = yield* application.operations.start(request(2));
        expect(rejectedHandle.state).toBe("awaiting-confirmation");
        yield* application.operations.reject(rejectedHandle.id);
        const afterRejection = yield* application.state.snapshot;

        const approvedHandle = yield* application.operations.start(request(3));
        expect(approvedHandle.confirmation).toBeDefined();
        yield* application.operations.confirm(approvedHandle.id, approvedHandle.confirmation!);
        const completed = yield* application.operations.await(approvedHandle.id);
        return { afterRejection, completed, final: yield* application.state.snapshot };
      }),
    );

    expect(result.afterRejection.durable.topics).toHaveLength(1);
    expect(result.completed.result?.status).toBe("succeeded");
    expect(result.final.durable.topics).toEqual([]);
  });

  test("denies and fails closed after invalid configuration without changing the Topic", async () => {
    for (const invalid of [false, true]) {
      const result = await runApplication("deny", (application, config) =>
        Effect.gen(function* () {
          if (invalid) yield* Effect.promise(() => writeFile(config, "{ invalid", { mode: 0o600 }));
          const attempt = yield* Effect.exit(
            application.operations.start(request(invalid ? 5 : 4)),
          );
          return { attempt, snapshot: yield* application.state.snapshot };
        }),
      );
      expect(result.attempt._tag).toBe("Failure");
      expect(result.snapshot.durable.topics).toHaveLength(1);
    }
  });
});
