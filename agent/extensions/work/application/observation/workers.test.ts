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
const NEW_ID = decodeTopicId("10000000-0000-4000-8000-000000000002");
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

const make = (
  git: GitControl,
  github: GitHubPullRequests = noPullRequests,
  associatePullRequest?: (
    topicId: typeof ID,
    number: number,
    observedAt: string,
  ) => Effect.Effect<void, unknown>,
) =>
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
      workspace: () => Effect.succeed(4),
      ...(associatePullRequest === undefined ? {} : { associatePullRequest }),
    });
    return { state, workers };
  });

describe("observation workers", () => {
  test("projects Base checkout and workspace with local Git facts", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const { state, workers } = yield* make(
          gitWithInspection(() =>
            Effect.succeed({ clean: true, checkedOutBranch: decodeBranch("topic") }),
          ),
        );
        yield* workers.refreshLocal;
        const observed = (yield* state.snapshot).observed.topics[0]?.value;
        expect(observed?.baseCheckout).toBe(decodeAbsolutePath("/tmp/repository"));
        expect(observed?.workspace).toBe(4);
      }),
    );

    await Effect.runPromise(program as Effect.Effect<void>);
  });

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

  test("reruns Integration Status after a Topic arrives during an older pass", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const git = {
          ...gitWithInspection(() => Effect.succeed({ clean: true })),
          integrationStatus: () =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return { kind: "current" as const, ahead: 1, behind: 0 as const };
            }),
        } as GitControl;
        const { state, workers } = yield* make(git);
        yield* workers.start;
        yield* Deferred.await(started);
        yield* state.publish({
          _tag: "DurableCommitted",
          topics: {
            upsert: [
              {
                topic: {
                  ...topic(),
                  id: NEW_ID,
                  name: "New Topic",
                  branch: decodeBranch("new-topic"),
                },
                rowRevision: 0,
              },
            ],
          },
        });
        yield* Effect.sleep("10 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep("10 millis");

        const observed = (yield* state.snapshot).observed.topics.find(
          (item) => item.topicId === NEW_ID,
        );
        expect(observed?.value?.integrationStatus.kind).toBe("current");
      }),
    );

    await Effect.runPromise(program as Effect.Effect<void>);
  });

  test("resubscribes after durable changes overflow its internal queue", async () => {
    const program = Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        const git = {
          ...gitWithInspection(() => Effect.succeed({ clean: true })),
          integrationStatus: () =>
            Effect.gen(function* () {
              calls += 1;
              if (calls === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return { kind: "current" as const, ahead: 1, behind: 0 as const };
            }),
        } as GitControl;
        const { state, workers } = yield* make(git);
        yield* workers.start;
        yield* Deferred.await(started);

        for (let revision = 1; revision <= 20; revision += 1) {
          yield* state.publish({
            _tag: "DurableCommitted",
            topics: { upsert: [{ topic: topic(), rowRevision: revision }] },
          });
        }
        yield* Deferred.succeed(release, undefined);
        yield* Effect.sleep("100 millis");

        yield* state.publish({
          _tag: "DurableCommitted",
          topics: {
            upsert: [
              {
                topic: {
                  ...topic(),
                  id: NEW_ID,
                  name: "New Topic",
                  branch: decodeBranch("new-topic"),
                },
                rowRevision: 0,
              },
            ],
          },
        });
        yield* Effect.sleep("20 millis");

        const observed = (yield* state.snapshot).observed.topics.find(
          (item) => item.topicId === NEW_ID,
        );
        expect(observed?.value?.integrationStatus.kind).toBe("current");
      }),
    );

    await Effect.runPromise(program as Effect.Effect<void>);
  });

  test("joins concurrent pull request refreshes into one observation pass", async () => {
    let starts = 0;
    const program = Effect.scoped(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const github = {
          observe: () =>
            Effect.gen(function* () {
              starts += 1;
              yield* Deferred.await(release);
              return null;
            }),
        } as GitHubPullRequests;
        const { workers } = yield* make(
          gitWithInspection(() => Effect.succeed({ clean: true })),
          github,
        );
        const first = yield* Effect.forkScoped(workers.refreshPullRequests);
        const second = yield* Effect.forkScoped(workers.refreshPullRequests);
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

  test("persists a discovered identity and preserves prior facts after a failed refresh", async () => {
    let fail = false;
    const associated: number[] = [];
    const github = {
      observe: () =>
        fail
          ? Effect.fail({ _tag: "GitHubFailure", message: "x".repeat(2_000) } as never)
          : Effect.succeed({
              number: 42,
              url: "https://github.com/owner/repo/pull/42",
              state: "merged" as const,
              draft: false,
              ci: "passing" as const,
              reviewPending: false,
              copilotReviewed: true,
              changesRequested: false,
              approved: true,
              unresolvedThreads: 0,
            }),
    } as GitHubPullRequests;
    const { state, workers } = await Effect.runPromise(
      make(
        gitWithInspection(() => Effect.succeed({ clean: true })),
        github,
        (_topicId, number) => Effect.sync(() => associated.push(number)).pipe(Effect.asVoid),
      ),
    );

    await Effect.runPromise(workers.refreshPullRequests as Effect.Effect<void>);
    fail = true;
    await Effect.runPromise(workers.refreshPullRequests as Effect.Effect<void>);
    const projected = (await Effect.runPromise(state.snapshot)).observed.pullRequests[0]!;
    expect(associated).toEqual([42]);
    expect(projected.value).toMatchObject({ identity: { number: 42 }, state: "merged" });
    expect(projected.freshness).toMatchObject({
      _tag: "Failed",
      message: "x".repeat(1_000),
    });
  });

  test("projects the exact Integration Target and commit counts", async () => {
    const { state, workers } = await Effect.runPromise(
      make(gitWithInspection(() => Effect.succeed({ clean: true }))),
    );

    await Effect.runPromise(workers.refreshIntegration as Effect.Effect<void>);

    expect((await Effect.runPromise(state.snapshot)).observed.topics[0]).toMatchObject({
      freshness: { _tag: "Fresh" },
      value: {
        integrationStatus: { kind: "current", target: "main", ahead: 1, behind: 0 },
      },
    });
  });

  test("keeps a bounded diagnostic and known target when Git observation fails", async () => {
    const diagnostic = "x".repeat(2_000);
    const git = {
      ...gitWithInspection(() => Effect.succeed({ clean: true })),
      integrationStatus: () => Effect.fail({ message: diagnostic } as never),
    } as GitControl;
    const { state, workers } = await Effect.runPromise(make(git));

    await Effect.runPromise(workers.refreshIntegration as Effect.Effect<void>);
    const observed = (await Effect.runPromise(state.snapshot)).observed.topics[0]!;

    expect(observed.freshness).toMatchObject({ _tag: "Failed", message: "x".repeat(1_000) });
    expect(observed.value?.integrationStatus).toMatchObject({
      kind: "unknown",
      diagnostic: "x".repeat(1_000),
    });
    expect(String(observed.value?.integrationStatus.target)).toBe("main");
  });
});
