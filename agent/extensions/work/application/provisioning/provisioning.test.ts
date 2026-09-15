import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

function program(path: string, decision: "allow" | "ask" = "allow") {
  const phases: string[] = [];
  const setup: string[] = [];
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
    const handle = yield* service.start({
      clientId: CLIENT,
      requestId: REQUEST,
      fingerprint: "durable-provisioning",
      value: value(decision),
    });
    if (handle.confirmation !== undefined) yield* engine.confirm(handle.id, handle.confirmation);
    const completed = yield* engine.await(handle.id);
    return { completed, topic: (yield* topics.get(TOPIC.id)).topic, phases, setup };
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

  test("persists confirmation before sensitive provisioning starts", async () => {
    const result = await Effect.runPromise(program(await database(), "ask"));
    expect(result.completed.state).toBe("succeeded");
    expect(result.setup).toEqual(["first", "second"]);
  });
});
