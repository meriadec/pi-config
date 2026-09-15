import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  decodeAbsolutePath,
  decodeBranch,
  decodeRepository,
  decodeTopicId,
  type DurableTopic,
} from "../../domain/index.ts";
import { makeKeyedConcurrency } from "../../infrastructure/concurrency/index.ts";
import type { GitControl } from "../../infrastructure/git/index.ts";
import type { GitHubPullRequests } from "../../infrastructure/github/index.ts";
import { makeWorkState } from "../state/index.ts";
import { makeObservationWorkers } from "./workers.ts";

const ID = decodeTopicId("10000000-0000-4000-8000-000000000001");
const NOW = "2026-06-01T00:00:00.000Z";

function topic(): DurableTopic {
  return {
    id: ID,
    name: "Topic",
    branch: decodeBranch("topic"),
    repository: decodeRepository("owner/repo"),
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: decodeAbsolutePath("/tmp/topic"),
    mainAgent: { sessionId: "session", sessionFile: null },
    partition: 0,
    integrationTarget: { kind: "integration-branch" },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function gitWithInspection(inspect: GitControl["inspectWorktree"]): GitControl {
  return {
    worktreePresent: () => Effect.succeed(true),
    inspectWorktree: inspect,
    integrationStatus: () => Effect.succeed({ kind: "current", ahead: 1, behind: 0 }),
  } as unknown as GitControl;
}

const noPullRequests = {
  observe: () => Effect.succeed(null),
} as GitHubPullRequests;

const make = (git: GitControl, github: GitHubPullRequests = noPullRequests) =>
  Effect.gen(function* () {
    const state = yield* makeWorkState({
      daemon: { id: "daemon", startedAt: NOW },
      durable: {
        topics: [{ topic: topic(), rowRevision: 0 }],
        repositoryStates: [],
        operations: [],
      },
    });
    const workers = yield* makeObservationWorkers({
      state,
      git,
      github,
      concurrency: makeKeyedConcurrency(),
      repositoryPath: () => decodeAbsolutePath("/tmp/repository"),
      integrationBranch: () => Effect.succeed(decodeBranch("main")),
      now: Effect.succeed(NOW),
      githubRetryDelay: () => Effect.succeed(100),
    });
    return { state, workers };
  });

describe("observation workers", () => {
  test("schedules local passes after completion without overlap", async () => {
    let active = 0;
    let maximum = 0;
    let starts = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const { workers } = yield* make(
          gitWithInspection(() =>
            Effect.gen(function* () {
              starts += 1;
              active += 1;
              maximum = Math.max(maximum, active);
              yield* Effect.sleep("5 seconds");
              active -= 1;
              return { clean: true, checkedOutBranch: decodeBranch("topic") };
            }),
          ),
        );
        yield* workers.start;
        yield* TestClock.adjust("34 seconds");
        expect(starts).toBe(1);
        yield* TestClock.adjust("1 second");
        expect(starts).toBe(2);
        expect(maximum).toBe(1);
      }),
    ).pipe(Effect.provide(TestClock.layer()));

    await Effect.runPromise(program as Effect.Effect<void>);
  });

  test("makes concurrent explicit refreshes join one pass", async () => {
    let starts = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const { workers } = yield* make(
          gitWithInspection(() =>
            Effect.gen(function* () {
              starts += 1;
              yield* Deferred.await(release);
              return { clean: true, checkedOutBranch: decodeBranch("topic") };
            }),
          ),
        );
        const first = yield* Effect.forkScoped(workers.refreshLocal);
        const second = yield* Effect.forkScoped(workers.refreshLocal);
        yield* Effect.yieldNow;
        expect(starts).toBe(1);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(starts).toBe(1);
      }),
    );

    await Effect.runPromise(program as Effect.Effect<void>);
  });

  test("retries transient GitHub failures with bounded Effect time", async () => {
    let calls = 0;
    const github = {
      observe: () => {
        calls += 1;
        return calls < 3
          ? Effect.fail({ _tag: "GitHubFailure", message: "temporary" } as never)
          : Effect.succeed(null);
      },
    } as unknown as GitHubPullRequests;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const { workers } = yield* make(
          gitWithInspection(() => Effect.succeed({ clean: true })),
          github,
        );
        const refresh = yield* Effect.forkScoped(workers.refreshPullRequests);
        yield* TestClock.adjust("200 millis");
        yield* Fiber.join(refresh);
        expect(calls).toBe(3);
      }),
    ).pipe(Effect.provide(TestClock.layer()));

    await Effect.runPromise(program as Effect.Effect<void>);
  });
});
