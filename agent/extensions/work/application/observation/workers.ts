import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  DomainFailure,
  type AbsolutePath,
  type Branch,
  type DurableTopic,
  type ObservedTopicState,
  type PublicWorkFailure,
  type Repository,
  type TopicId,
} from "../../domain/index.ts";
import { repositoryKey, type KeyedConcurrency } from "../../infrastructure/concurrency/index.ts";
import type { GitControl, GitWorktreeInspection } from "../../infrastructure/git/index.ts";
import type {
  GitHubPullRequests,
  PullRequestObservation,
} from "../../infrastructure/github/index.ts";
import type { StorageMaintenance } from "../../infrastructure/storage/index.ts";
import type {
  ObservationFreshness,
  ProjectedTopicObservation,
  WorkStateProjection,
} from "../state/index.ts";

const LOCAL_INTERVAL_MS = 30_000;
const PULL_REQUEST_INTERVAL_MS = 60_000;
const DAILY_INTERVAL_MS = 24 * 60 * 60_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_GITHUB_ATTEMPTS = 3;

export interface ObservationWorkersOptions {
  readonly state: WorkStateProjection;
  readonly git: GitControl;
  readonly github: GitHubPullRequests;
  readonly concurrency: KeyedConcurrency;
  readonly repositoryPath: (repository: Repository) => AbsolutePath;
  readonly integrationBranch: (
    repository: Repository,
  ) => Effect.Effect<Branch | undefined, PublicWorkFailure>;
  readonly mainAgentActivity?: (topicId: TopicId) => ObservedTopicState["mainAgentActivity"];
  readonly maintenance?: StorageMaintenance;
  readonly now?: Effect.Effect<string>;
  readonly localIntervalMs?: number;
  readonly pullRequestIntervalMs?: number;
  readonly dailyIntervalMs?: number;
  readonly observationConcurrency?: number;
  /** Test seam. Production uses bounded exponential delay with random jitter. */
  readonly githubRetryDelay?: (attempt: number) => Effect.Effect<number>;
}

type WorkerRequirements = ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;

export interface ObservationWorkers {
  /** Starts all schedules in the caller's Scope. Readiness does not await an observation. */
  readonly start: Effect.Effect<void, never, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>;
  /** Joins passes that are already running. */
  readonly refresh: Effect.Effect<void, never, WorkerRequirements>;
  readonly refreshLocal: Effect.Effect<void, never, WorkerRequirements>;
  readonly refreshIntegration: Effect.Effect<void, never, WorkerRequirements>;
  readonly refreshPullRequests: Effect.Effect<void, never, WorkerRequirements>;
  /** An explicit, non-resumable ADR-0002 action. */
  readonly rebase: (topicId: TopicId) => Effect.Effect<void, PublicWorkFailure, WorkerRequirements>;
}

type Pass = () => Effect.Effect<void, never, WorkerRequirements>;

/**
 * Owns observation single-flight, schedules, progressive publication, and guarded rebases.
 * Construction starts no fibers. `start` must run in the daemon Scope.
 */
export const makeObservationWorkers = (
  options: ObservationWorkersOptions,
): Effect.Effect<ObservationWorkers> =>
  Effect.gen(function* () {
    const publication = yield* Semaphore.make(1);
    const now =
      options.now ??
      Clock.currentTimeMillis.pipe(Effect.map((value) => new Date(value).toISOString()));
    const limit = normalizeConcurrency(options.observationConcurrency ?? DEFAULT_CONCURRENCY);

    const publishTopic = (item: ProjectedTopicObservation) =>
      publication.withPermit(
        options.state
          .publish({ _tag: "ObservedChanged", topics: { upsert: [item] } })
          .pipe(Effect.asVoid),
      );

    const updateTopic = (
      topic: DurableTopic,
      freshness: ObservationFreshness,
      change: Partial<NonNullable<ProjectedTopicObservation["value"]>>,
    ) =>
      publication.withPermit(
        Effect.gen(function* () {
          const snapshot = yield* options.state.snapshot;
          const old = snapshot.observed.topics.find((item) => item.topicId === topic.id)?.value;
          const value = {
            topicId: topic.id,
            integrationStatus: old?.integrationStatus ?? "unknown",
            gitOperationState: old?.gitOperationState ?? "unknown",
            worktreePresent: old?.worktreePresent ?? false,
            worktreeClean: old?.worktreeClean ?? null,
            orphan: old?.orphan ?? false,
            ...(old?.mainAgentActivity === undefined
              ? {}
              : { mainAgentActivity: old.mainAgentActivity }),
            ...change,
          } as NonNullable<ProjectedTopicObservation["value"]>;
          yield* options.state.publish({
            _tag: "ObservedChanged",
            topics: { upsert: [{ topicId: topic.id, freshness, value }] },
          });
        }),
      );

    const markRefreshing = (topics: ReadonlyArray<DurableTopic>, startedAt: string) =>
      Effect.forEach(
        topics,
        (topic) => {
          const oldEffect = options.state.snapshot.pipe(
            Effect.map((snapshot) =>
              snapshot.observed.topics.find((item) => item.topicId === topic.id),
            ),
          );
          return oldEffect.pipe(
            Effect.flatMap((old) =>
              publishTopic({
                topicId: topic.id,
                freshness: { _tag: "Refreshing", startedAt },
                ...(old?.value === undefined ? {} : { value: old.value }),
              }),
            ),
          );
        },
        { concurrency: 1 },
      ).pipe(Effect.asVoid);

    const durableTopics = options.state.snapshot.pipe(
      Effect.map((snapshot) => snapshot.durable.topics.map((item) => item.topic)),
    );

    const localPass: Pass = () =>
      Effect.gen(function* () {
        const topics = yield* durableTopics;
        yield* markRefreshing(topics, yield* now);
        yield* Effect.forEach(
          topics,
          (topic) =>
            observeLocal(options, topic).pipe(
              Effect.flatMap((value) =>
                now.pipe(
                  Effect.flatMap((observedAt) =>
                    updateTopic(topic, { _tag: "Fresh", observedAt }, value),
                  ),
                ),
              ),
              Effect.catch((error) =>
                now.pipe(
                  Effect.flatMap((failedAt) =>
                    updateTopic(
                      topic,
                      { _tag: "Failed", failedAt, message: publicMessage(error) },
                      options.mainAgentActivity?.(topic.id) === undefined
                        ? {}
                        : { mainAgentActivity: options.mainAgentActivity!(topic.id) },
                    ),
                  ),
                ),
              ),
            ),
          { concurrency: limit },
        );
      });

    const integrationPass: Pass = () =>
      Effect.gen(function* () {
        const topics = yield* durableTopics;
        yield* markRefreshing(topics, yield* now);
        yield* Effect.forEach(
          topics,
          (topic) =>
            integrationTarget(options, topic, topics).pipe(
              Effect.flatMap((target) =>
                target === undefined || topic.worktreePath === null
                  ? Effect.succeed("unknown" as const)
                  : options.git
                      .integrationStatus(
                        options.repositoryPath(topic.repository),
                        topic.branch,
                        target,
                      )
                      .pipe(Effect.map((status) => status.kind)),
              ),
              Effect.flatMap((integrationStatus) =>
                now.pipe(
                  Effect.flatMap((observedAt) =>
                    updateTopic(topic, { _tag: "Fresh", observedAt }, { integrationStatus }),
                  ),
                ),
              ),
              Effect.catch((error) =>
                now.pipe(
                  Effect.flatMap((failedAt) =>
                    updateTopic(
                      topic,
                      { _tag: "Failed", failedAt, message: publicMessage(error) },
                      { integrationStatus: "unknown" },
                    ),
                  ),
                ),
              ),
            ),
          { concurrency: limit },
        );
      });

    const pullRequestPass: Pass = () =>
      Effect.gen(function* () {
        const topics = (yield* durableTopics).filter((topic) => topic.worktreePath !== null);
        const startedAt = yield* now;
        yield* Effect.forEach(
          topics,
          (topic) =>
            options.state.snapshot.pipe(
              Effect.flatMap((snapshot) => {
                const old = snapshot.observed.pullRequests.find(
                  (item) => item.topicId === topic.id,
                );
                return options.state.publish({
                  _tag: "ObservedChanged",
                  pullRequests: {
                    upsert: [
                      {
                        topicId: topic.id,
                        freshness: { _tag: "Refreshing", startedAt },
                        ...(old?.value === undefined ? {} : { value: old.value }),
                      },
                    ],
                  },
                });
              }),
              Effect.asVoid,
            ),
          { concurrency: 1 },
        );
        yield* Effect.forEach(
          topics,
          (topic) =>
            observePullRequest(options, topic).pipe(
              Effect.flatMap((value) =>
                now.pipe(
                  Effect.flatMap((observedAt) =>
                    options.state.publish({
                      _tag: "ObservedChanged",
                      pullRequests: {
                        upsert: [
                          {
                            topicId: topic.id,
                            freshness: { _tag: "Fresh", observedAt },
                            ...(value === null ? {} : { value: projectPullRequest(value) }),
                          },
                        ],
                      },
                    }),
                  ),
                ),
              ),
              Effect.catch((error) =>
                Effect.all({ snapshot: options.state.snapshot, failedAt: now }).pipe(
                  Effect.flatMap(({ snapshot, failedAt }) => {
                    const old = snapshot.observed.pullRequests.find(
                      (item) => item.topicId === topic.id,
                    );
                    return options.state.publish({
                      _tag: "ObservedChanged",
                      pullRequests: {
                        upsert: [
                          {
                            topicId: topic.id,
                            freshness: {
                              _tag: "Failed",
                              failedAt,
                              message: publicMessage(error),
                            },
                            ...(old?.value === undefined ? {} : { value: old.value }),
                          },
                        ],
                      },
                    });
                  }),
                ),
              ),
            ),
          { concurrency: limit },
        );
      });

    const local = yield* singleFlight(localPass);
    const integration = yield* singleFlight(integrationPass);
    const pullRequests = yield* singleFlight(pullRequestPass);

    const loop = (pass: Effect.Effect<void, never, WorkerRequirements>, interval: number) =>
      Effect.forever(pass.pipe(Effect.andThen(Effect.sleep(interval))));

    const start = Effect.gen(function* () {
      yield* Effect.forkScoped(loop(local, options.localIntervalMs ?? LOCAL_INTERVAL_MS));
      yield* Effect.forkScoped(
        loop(pullRequests, options.pullRequestIntervalMs ?? PULL_REQUEST_INTERVAL_MS),
      );
      // Integration status gets its startup background refresh independently of readiness.
      yield* Effect.forkScoped(integration);
      const changes = yield* options.state.subscribe(16);
      yield* Effect.addFinalizer(() => changes.close);
      yield* Effect.forkScoped(
        changes.stream.pipe(
          Stream.runForEach((item) =>
            item._tag === "Change" && item.change._tag === "DurableCommitted"
              ? integration
              : Effect.void,
          ),
        ),
      );
      if (options.maintenance !== undefined) {
        yield* startDailyBackup(
          options,
          options.maintenance,
          options.dailyIntervalMs ?? DAILY_INTERVAL_MS,
        );
      }
    });

    const rebase = (topicId: TopicId): Effect.Effect<void, PublicWorkFailure, WorkerRequirements> =>
      Effect.gen(function* () {
        const initial = yield* options.state.snapshot;
        const topic = initial.durable.topics.find((item) => item.topic.id === topicId)?.topic;
        if (topic === undefined) return yield* invalid("Topic does not exist.");
        if (topic.worktreePath === null) return yield* invalid("The Topic Worktree is absent.");

        yield* options.concurrency.withKeys(
          [repositoryKey(topic.repository)],
          Effect.gen(function* () {
            // Re-read every volatile ADR-0002 guard while holding the repository mutation key.
            const current = yield* options.state.snapshot;
            const durable = current.durable.topics.find((item) => item.topic.id === topicId)?.topic;
            if (
              durable === undefined ||
              durable.branch !== topic.branch ||
              durable.worktreePath !== topic.worktreePath
            )
              return yield* invalid("The Topic changed before rebase execution.");
            const target = yield* integrationTarget(
              options,
              durable,
              current.durable.topics.map((item) => item.topic),
            );
            if (target === undefined)
              return yield* invalid("The Topic has no direct Integration Target.");
            const observation = current.observed.topics.find(
              (item) => item.topicId === topicId,
            )?.value;
            const pullRequest = current.observed.pullRequests.find(
              (item) => item.topicId === topicId,
            )?.value;
            const activity = options.mainAgentActivity?.(topicId) ?? observation?.mainAgentActivity;
            if (pullRequest?.state === "open")
              return yield* invalid("A known pull request prevents rebase.");
            if (activity === "starting" || activity === "thinking" || activity === "thinking-sub")
              return yield* invalid("The active Main Agent prevents rebase.");

            const action = {
              id: `rebase:${topicId}`,
              kind: "topic.rebase",
              topicId,
              startedAt: yield* now,
            };
            yield* options.state.publish({
              _tag: "ObservedChanged",
              activeActions: [
                ...current.observed.activeActions.filter((item) => item.id !== action.id),
                action,
              ],
            });
            yield* options.git
              .guardedRebase({
                worktreePath: durable.worktreePath!,
                branch: durable.branch,
                targetBranch: target,
              })
              .pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    const after = yield* options.state.snapshot;
                    yield* options.state.publish({
                      _tag: "ObservedChanged",
                      activeActions: after.observed.activeActions.filter(
                        (item) => item.id !== action.id,
                      ),
                    });
                    // A second call guarantees a post-rebase pass when the first call joined an
                    // older pass. Never continue or abort a stopped Git operation.
                    yield* local;
                    yield* local;
                    yield* integration;
                    yield* integration;
                  }).pipe(Effect.catchCause(() => Effect.void)),
                ),
              );
          }),
        );
      });

    return {
      start,
      refresh: Effect.all([local, integration, pullRequests], { concurrency: "unbounded" }).pipe(
        Effect.asVoid,
      ),
      refreshLocal: local,
      refreshIntegration: integration,
      refreshPullRequests: pullRequests,
      rebase,
    };
  });

function singleFlight(pass: Pass): Effect.Effect<Effect.Effect<void, never, WorkerRequirements>> {
  return Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    let running: Deferred.Deferred<void> | undefined;
    return Effect.gen(function* () {
      const choice = yield* mutex.withPermit(
        Effect.gen(function* () {
          if (running !== undefined) return { leader: false as const, deferred: running };
          const deferred = yield* Deferred.make<void>();
          running = deferred;
          return { leader: true as const, deferred };
        }),
      );
      if (!choice.leader) return yield* Deferred.await(choice.deferred);
      yield* pass().pipe(
        Effect.ensuring(
          mutex.withPermit(
            Deferred.succeed(choice.deferred, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  running = undefined;
                }),
              ),
            ),
          ),
        ),
      );
    });
  });
}

function observeLocal(
  options: ObservationWorkersOptions,
  topic: DurableTopic,
): Effect.Effect<Partial<ObservedTopicState>, PublicWorkFailure, WorkerRequirements> {
  const activity = options.mainAgentActivity?.(topic.id);
  const absent = (): Partial<ObservedTopicState> => ({
    worktreePresent: false,
    worktreeClean: null,
    gitOperationState: "none",
    orphan: topic.setup.state === "ready",
    ...(activity === undefined ? {} : { mainAgentActivity: activity }),
  });
  if (topic.worktreePath === null) return Effect.succeed(absent());
  return options.git.worktreePresent(topic.worktreePath).pipe(
    Effect.flatMap((present) =>
      present
        ? options.git.inspectWorktree(topic.worktreePath!).pipe(
            Effect.map(
              (inspection): Partial<ObservedTopicState> => ({
                worktreePresent: true,
                worktreeClean: inspection.clean,
                gitOperationState: operationState(inspection),
                orphan: false,
                ...(activity === undefined ? {} : { mainAgentActivity: activity }),
              }),
            ),
          )
        : Effect.succeed(absent()),
    ),
  );
}

function operationState(
  inspection: GitWorktreeInspection,
): ObservedTopicState["gitOperationState"] {
  return inspection.operation?.kind ?? "none";
}

function integrationTarget(
  options: ObservationWorkersOptions,
  topic: DurableTopic,
  topics: ReadonlyArray<DurableTopic>,
): Effect.Effect<Branch | undefined, PublicWorkFailure> {
  const target = topic.integrationTarget;
  if (target?.kind === "topic") {
    return Effect.succeed(topics.find((item) => item.id === target.topicId)?.branch);
  }
  if (topic.integrationTarget?.kind === "integration-branch") {
    return options.integrationBranch(topic.repository);
  }
  return Effect.succeed(undefined);
}

function observePullRequest(options: ObservationWorkersOptions, topic: DurableTopic) {
  const target = {
    repository: topic.repository,
    branch: topic.branch,
    worktreePath: topic.worktreePath!,
    ...(topic.pullRequest === undefined
      ? {}
      : { knownPullRequestNumber: topic.pullRequest.number }),
  };
  const delay =
    options.githubRetryDelay ??
    ((attempt: number) =>
      Effect.sync(() => Math.round(250 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5))));
  const attempt = (number: number): ReturnType<GitHubPullRequests["observe"]> =>
    options.github
      .observe(target)
      .pipe(
        Effect.catch((error) =>
          number >= MAX_GITHUB_ATTEMPTS
            ? Effect.fail(error)
            : delay(number).pipe(Effect.flatMap(Effect.sleep), Effect.andThen(attempt(number + 1))),
        ),
      );
  return attempt(1);
}

function projectPullRequest(value: PullRequestObservation) {
  return {
    identity: { number: value.number },
    url: value.url,
    state: value.state,
    draft: value.draft,
    ci: value.ci,
    reviewPending: value.reviewPending,
    copilotReviewed: value.copilotReviewed,
    changesRequested: value.changesRequested,
    approved: value.approved,
    unresolvedThreads: value.unresolvedThreads,
  };
}

function publicMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message.slice(0, 1_000) || "Observation failed.";
  return "Observation failed.";
}

function invalid(message: string): Effect.Effect<never, PublicWorkFailure> {
  return Effect.fail(new DomainFailure({ reason: "invalid-input", message }));
}

function normalizeConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64)
    throw new RangeError("Observation concurrency must be from 1 through 64.");
  return value;
}

function startDailyBackup(
  options: ObservationWorkersOptions,
  maintenance: StorageMaintenance,
  interval: number,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const dirty = yield* Ref.make(false);
    const subscription = yield* options.state.subscribe(16);
    yield* Effect.addFinalizer(() => subscription.close);
    yield* Effect.forkScoped(
      subscription.stream.pipe(
        Stream.runForEach((item) =>
          item._tag === "Change" && item.change._tag === "DurableCommitted"
            ? Ref.set(dirty, true)
            : Effect.void,
        ),
      ),
    );
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(interval).pipe(
          Effect.andThen(Ref.getAndSet(dirty, false)),
          Effect.flatMap((changed) =>
            changed
              ? maintenance
                  .backup({ kind: "daily", sourceIdentity: "daemon-durable-state" })
                  .pipe(Effect.catch(() => Ref.set(dirty, true)))
              : Effect.void,
          ),
        ),
      ),
    );
  });
}
