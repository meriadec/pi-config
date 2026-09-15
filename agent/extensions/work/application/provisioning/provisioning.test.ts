import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  AbsolutePath,
  ClientId,
  DurableTopic,
  OperationId,
  RequestId,
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
import { makeTopicCommands } from "../command/index.ts";
import {
  makeProvisioningService,
  makeProvisioningWorker,
  type ProvisioningControl,
  type ProvisionOperationValue,
} from "./provisioning.ts";

const paths = new Set<string>();
afterEach(async () => {
  await Promise.all([...paths].map((path) => rm(path, { recursive: true, force: true })));
  paths.clear();
});

const TOPIC = Schema.decodeUnknownSync(DurableTopic)({
  id: "11111111-1111-4111-8111-111111111111",
  name: "Durable provisioning",
  branch: "feature/durable",
  repository: "owner/repo",
  setup: {
    state: "provisioning",
    repositoryAvailable: false,
    worktreeCreated: false,
    setupCommandsRun: false,
    completedCommandCount: 0,
  },
  worktreePath: null,
  mainAgent: { sessionId: "unassigned", sessionFile: null },
  partition: 0,
  integrationTarget: { kind: "integration-branch" },
  chainState: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const CLIENT = ClientId.make("22222222-2222-4222-8222-222222222222");
const REQUEST = RequestId.make("33333333-3333-4333-8333-333333333333");
const OPERATION = OperationId.make("44444444-4444-4444-8444-444444444444");
const WORK_BASE = AbsolutePath.make("/tmp/work");
const WORKTREE = AbsolutePath.make("/tmp/worktree");

function value(decision: "allow" | "ask" = "allow"): ProvisionOperationValue {
  return {
    attempt: "create-root",
    topic: TOPIC,
    workBase: WORK_BASE,
    recipe: { setupCommands: ["first", "second"] },
    policies: {
      "repository.clone": decision,
      "topic.create-worktree": decision,
      "topic.run-setup": decision,
      "terminal.open": "deny",
      "agent.open": "deny",
      "agent.reset": "deny",
      "topic.delete": "deny",
    },
  };
}

function control(phases: string[]): ProvisioningControl {
  return {
    inspectBaseCheckout: () => Effect.succeed("missing"),
    cloneRepository: () => Effect.sync(() => phases.push("clone")),
    validateStartPoint: () => Effect.void,
    ensureBranch: () => Effect.void,
    discoverWorktree: () => Effect.succeed(undefined),
    createWorktree: () => Effect.sync(() => (phases.push("worktree"), WORKTREE)),
    validateWorktree: () => Effect.void,
  };
}

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-provisioning-"));
  paths.add(directory);
  const path = join(directory, "work.db");
  // Install migrations before the two repository Layers open the same database.
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TopicRepository;
    }).pipe(Effect.scoped, Effect.provide(topicRepositoryLayer({ filename: path }))),
  );
  return path;
}

function program(path: string, decision: "allow" | "ask" = "allow", failingSetupCommand?: string) {
  const phases: string[] = [];
  const setup: string[] = [];
  const setupShells: string[] = [];
  return Effect.gen(function* () {
    const topics = yield* TopicRepository;
    const operations = yield* OperationRepository;
    const state = yield* makeWorkState({
      daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
    });
    const worker = makeProvisioningWorker({
      topics,
      operations,
      state,
      concurrency: makeKeyedConcurrency(),
      control: control(phases),
      runSetupCommand: ({ command, shell }) =>
        Effect.sync(() => {
          setup.push(command);
          setupShells.push(shell);
          return {
            status: "completed" as const,
            exitCode: command === failingSetupCommand ? 23 : 0,
            stdout: "",
            stderr:
              command === failingSetupCommand ? '/bin/sh: 42: Syntax error: "(" unexpected' : "",
            outputTruncated: false,
          };
        }),
    });
    const engine = yield* makeOperationEngine({
      repository: operations,
      state,
      workers: { "topic.provision": worker },
      makeOperationId: () => OPERATION,
    });
    const service = makeProvisioningService(engine);
    const handle = yield* service.start({
      clientId: CLIENT,
      requestId: REQUEST,
      fingerprint: "durable-provisioning",
      value: value(decision),
    });
    if (handle.confirmation !== undefined) yield* engine.confirm(handle.id, handle.confirmation);
    const completed = yield* engine.await(handle.id);
    return {
      completed,
      topic: (yield* topics.get(TOPIC.id)).topic,
      phases,
      setup,
      setupShells,
      confirmationText: handle.confirmationText,
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        topicRepositoryLayer({ filename: path }),
        operationRepositoryLayer({ filename: path }),
      ),
    ),
  );
}

function retryProgram(path: string, decision: "allow" | "ask" = "allow") {
  const setup: string[] = [];
  const forbidden: string[] = [];
  const failedTopic: typeof TOPIC = {
    ...TOPIC,
    partition: 4,
    setup: {
      state: "setup-failed",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: false,
      completedCommandCount: 1,
      reason: "A Setup command failed.",
    },
    worktreePath: WORKTREE,
  };
  return Effect.gen(function* () {
    const topics = yield* TopicRepository;
    const operations = yield* OperationRepository;
    yield* topics.create(failedTopic);
    const state = yield* makeWorkState({
      daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
    });
    const worker = makeProvisioningWorker({
      topics,
      operations,
      state,
      concurrency: makeKeyedConcurrency(),
      control: {
        ...control(forbidden),
        inspectBaseCheckout: () => Effect.succeed("valid"),
        cloneRepository: () => Effect.sync(() => forbidden.push("clone")),
        discoverWorktree: () => Effect.sync(() => (forbidden.push("discover"), undefined)),
        createWorktree: () => Effect.sync(() => (forbidden.push("create"), WORKTREE)),
      },
      runSetupCommand: ({ command }) =>
        Effect.sync(() => {
          setup.push(command);
          return {
            status: "completed" as const,
            exitCode: 0,
            stdout: "",
            stderr: "",
            outputTruncated: false,
          };
        }),
    });
    const engine = yield* makeOperationEngine({
      repository: operations,
      state,
      workers: { "topic.provision": worker },
      makeOperationId: () => OPERATION,
    });
    const service = makeProvisioningService(engine);
    const retryValue: ProvisionOperationValue = {
      ...value(),
      attempt: "retry",
      topic: failedTopic,
      policies: { ...value().policies, "topic.run-setup": decision },
    };
    const handle = yield* service.start({
      clientId: CLIENT,
      requestId: REQUEST,
      fingerprint: "retry-setup",
      value: retryValue,
    });
    const awaitingConfirmation = handle.state === "awaiting-confirmation";
    if (handle.confirmation !== undefined) yield* engine.confirm(handle.id, handle.confirmation);
    const completed = yield* engine.await(handle.id);
    return {
      completed,
      awaitingConfirmation,
      topic: (yield* topics.get(TOPIC.id)).topic,
      setup,
      forbidden,
    };
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        topicRepositoryLayer({ filename: path }),
        operationRepositoryLayer({ filename: path }),
      ),
    ),
  );
}

describe("durable Topic provisioning", () => {
  test("creates, checkpoints, and readies one Topic without storing Start Point data", async () => {
    const result = await Effect.runPromise(program(await database()));
    expect(result.completed.state).toBe("succeeded");
    expect(result.topic.setup).toMatchObject({
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 2,
    });
    expect(result.topic.worktreePath).toBe(WORKTREE);
    expect(result.setup).toEqual(["first", "second"]);
    expect(result.phases).toEqual(["clone", "worktree"]);
    expect("startPoint" in result.topic).toBe(false);
  });

  test("moves a Topic Partition while its Repository Recipe is running", async () => {
    const path = await database();
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const topics = yield* TopicRepository;
        const operations = yield* OperationRepository;
        const state = yield* makeWorkState({
          daemon: { id: "test", startedAt: "2026-01-01T00:00:00.000Z" },
        });
        const concurrency = makeKeyedConcurrency();
        const setupStarted = yield* Deferred.make<void>();
        const releaseSetup = yield* Deferred.make<void>();
        const worker = makeProvisioningWorker({
          topics,
          operations,
          state,
          concurrency,
          control: control([]),
          runSetupCommand: ({ command }) =>
            (command === "first"
              ? Deferred.succeed(setupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseSetup)),
                )
              : Effect.void
            ).pipe(
              Effect.as({
                status: "completed" as const,
                exitCode: 0,
                stdout: "",
                stderr: "",
                outputTruncated: false,
              }),
            ),
        });
        const engine = yield* makeOperationEngine({
          repository: operations,
          state,
          workers: { "topic.provision": worker },
        });
        const commands = makeTopicCommands({
          topics,
          operations: engine,
          state,
          concurrency,
          ancestry: { readStable: () => Effect.succeed(() => true) },
          integrationBranches: {
            configured: () => Effect.succeed(undefined),
            infer: () => Effect.succeed(undefined),
          },
          repositoryPath: () => AbsolutePath.make("/tmp/repository"),
          now: Effect.succeed("2026-01-01T01:00:00.000Z"),
        });
        yield* topics.create(
          Schema.decodeUnknownSync(DurableTopic)({
            ...TOPIC,
            id: "55555555-5555-4555-8555-555555555555",
            name: "Earlier Topic",
            branch: "feature/earlier",
            partition: 1,
            setup: {
              state: "ready",
              repositoryAvailable: true,
              worktreeCreated: true,
              setupCommandsRun: true,
              completedCommandCount: 0,
            },
            worktreePath: "/tmp/earlier",
          }),
        );
        const service = makeProvisioningService(engine);
        const handle = yield* service.start({
          clientId: CLIENT,
          requestId: REQUEST,
          fingerprint: "move-during-setup",
          value: value(),
        });
        yield* Deferred.await(setupStarted);
        const moved = yield* commands
          .execute({
            clientId: CLIENT,
            requestId: RequestId.make("66666666-6666-4666-8666-666666666666"),
            command: { _tag: "MovePartition", topicId: TOPIC.id, direction: "down" },
          })
          .pipe(Effect.timeoutOption(25));
        yield* Deferred.succeed(releaseSetup, undefined);
        yield* engine.await(handle.id);
        return { movedBeforeSetupFinished: Option.isSome(moved) };
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

    expect(result.movedBeforeSetupFinished).toBeTrue();
  });

  test("runs Repository Recipes with the operating-system login shell", async () => {
    const result = await Effect.runPromise(program(await database()));

    const shell = userInfo().shell || "/bin/sh";
    expect(result.setupShells).toEqual([shell, shell]);
  });

  test("persists confirmation before sensitive provisioning starts", async () => {
    const result = await Effect.runPromise(program(await database(), "ask"));
    expect(result.completed.state).toBe("succeeded");
    expect(result.setup).toEqual(["first", "second"]);
    expect(result.confirmationText).toBe(
      "Create and provision Topic “Durable provisioning” in owner/repo on Branch feature/durable? Approve: topic.create-worktree, topic.run-setup, repository.clone.",
    );
  });

  test("identifies a failed Setup command and persists a bounded output excerpt", async () => {
    const result = await Effect.runPromise(program(await database(), "allow", "second"));
    const message =
      'Setup command 2 of 2 failed with exit code 23: /bin/sh: 42: Syntax error: "(" unexpected';

    expect(result.completed.result?.value).toEqual({
      reason: "invalid-state",
      message,
    });
    expect(result.topic.setup).toMatchObject({
      state: "setup-failed",
      reason: message,
      completedCommandCount: 1,
    });
    expect(result.topic.setup.reason).toBe(message);
    expect(message).not.toContain("second");
    expect(message.length).toBeLessThanOrEqual(200);
  });

  test("retries every Recipe command from command one without changing Topic placement", async () => {
    const result = await Effect.runPromise(retryProgram(await database()));
    expect(result.completed.state).toBe("succeeded");
    expect(result.setup).toEqual(["first", "second"]);
    expect(result.forbidden).toEqual([]);
    expect(result.topic).toMatchObject({
      id: TOPIC.id,
      branch: TOPIC.branch,
      repository: TOPIC.repository,
      partition: 4,
      worktreePath: WORKTREE,
      setup: { state: "ready", setupCommandsRun: true, completedCommandCount: 2 },
    });
  });

  test("uses direct confirmation only when topic.run-setup is ask", async () => {
    const result = await Effect.runPromise(retryProgram(await database(), "ask"));
    expect(result.awaitingConfirmation).toBeTrue();
    expect(result.completed.state).toBe("succeeded");
  });
});
