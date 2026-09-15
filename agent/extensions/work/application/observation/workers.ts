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
  readonly workspace?: (
    topicId: TopicId,
  ) => Effect.Effect<number | undefined, never, WorkerRequirements>;
  /** Persists the first discovered identity before its live facts are published. */
  readonly associatePullRequest?: (
    topicId: TopicId,
    number: number,
    observedAt: string,
  ) => Effect.Effect<void, unknown>;
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
            integrationStatus: old?.integrationStatus ?? { kind: "unknown" },
            gitOperationState: old?.gitOperationState ?? "unknown",
            ...(old?.checkedOutBranch === undefined
              ? {}
              : { checkedOutBranch: old.checkedOutBranch }),
            ...(old?.gitOperationConflict === undefined
              ? {}
              : { gitOperationConflict: old.gitOperationConflict }),
            ...(old?.baseCheckout === undefined ? {} : { baseCheckout: old.baseCheckout }),
            ...(old?.workspace === undefined ? {} : { workspace: old.workspace }),
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
          (topic) => {
            let resolvedTarget: Branch | undefined;
            return Effect.gen(function* () {
              const target = yield* integrationTarget(options, topic, topics);
              resolvedTarget = target;
              const integrationStatus =
                target === undefined
                  ? {
                      kind: "unknown" as const,
                      diagnostic: "The direct Integration Target Branch is unavailable.",
                    }
                  : topic.worktreePath === null
                    ? {
                        kind: "unknown" as const,
                        target,
                        diagnostic: "The Topic Worktree is not ready.",
                      }
                    : yield* options.git
                        .integrationStatus(
                          options.repositoryPath(topic.repository),
                          topic.branch,
                          target,
                        )
                        .pipe(Effect.map((status) => ({ ...status, target })));
              const observedAt = yield* now;
              yield* updateTopic(topic, { _tag: "Fresh", observedAt }, { integrationStatus });
            }).pipe(
              Effect.catch((error) =>
                now.pipe(
                  Effect.flatMap((failedAt) => {
                    const diagnostic = publicMessage(error);
                    return updateTopic(
                      topic,
                      { _tag: "Failed", failedAt, message: diagnostic },
                      {
                        integrationStatus: {
                          kind: "unknown",
                          ...(resolvedTarget === undefined ? {} : { target: resolvedTarget }),
                          diagnostic,
                        },
                      },
                    );
                  }),
                ),
              ),
            );
          },
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
                Effect.gen(function* () {
                  const observedAt = yield* now;
                  if (value !== null && topic.pullRequest === undefined)
                    yield* (
                      options.associatePullRequest?.(topic.id, value.number, observedAt) ??
                        Effect.void
                    );
                  yield* options.state.publish({
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
                  });
                }),
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
    const watcherStarted = yield* Deferred.make<void>();

    const loop = (pass: Effect.Effect<void, never, WorkerRequirements>, interval: number) =>
      Effect.forever(pass.pipe(Effect.andThen(Effect.sleep(interval))));

    const watchDurableChanges = Effect.forever(
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* options.state.subscribe(16);
          yield* Deferred.succeed(watcherStarted, undefined);
          yield* Effect.addFinalizer(() => changes.close);
          yield* changes.stream.pipe(
            Stream.runForEach((item) =>
              (item._tag === "Change" && item.change._tag === "DurableCommitted") ||
              item._tag === "ResyncRequired"
                ? // The first call can join a pass that captured older durable state. The second
                  // call guarantees one pass that starts after that joined pass completes.
                  integration.pipe(Effect.andThen(integration))
                : Effect.void,
            ),
          );
        }),
      ),
    );

    const start = Effect.gen(function* () {
      yield* Effect.forkScoped(loop(local, options.localIntervalMs ?? LOCAL_INTERVAL_MS));
      yield* Effect.forkScoped(
        loop(pullRequests, options.pullRequestIntervalMs ?? PULL_REQUEST_INTERVAL_MS),
      );
      // Integration status gets its startup background refresh independently of readiness.
      yield* Effect.forkScoped(integration);
      // A dropping projection subscription ends after ResyncRequired. Always subscribe again.
      yield* Effect.forkScoped(watchDurableChanges);
      yield* Deferred.await(watcherStarted);
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
            if (observation?.orphan) return yield* invalid("The Topic Worktree is missing.");
            if (observation?.integrationStatus.kind !== "behind")
              return yield* invalid(
                observation?.integrationStatus.diagnostic ??
                  "The Topic Integration Status is not Behind.",
              );
            if (observation.worktreeClean !== true)
              return yield* invalid(
                observation.worktreeClean === false
                  ? "The Topic Worktree has local changes."
                  : "The Topic Worktree state is unknown.",
              );
            if (observation.checkedOutBranch !== durable.branch)
              return yield* invalid("The Topic Branch is not checked out.");
            if (observation.gitOperationState !== "none")
              return yield* invalid("The Topic has a Git operation in progress.");
            const targetSpec = durable.integrationTarget;
            if (targetSpec?.kind === "topic") {
              const targetObservation = current.observed.topics.find(
                (item) => item.topicId === targetSpec.topicId,
              )?.value;
              if (
                targetObservation?.gitOperationState !== undefined &&
                targetObservation.gitOperationState !== "none"
              )
                return yield* invalid("The Integration Target has a Git operation in progress.");
            }
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
  return Effect.gen(function* () {
    const workspace =
      options.workspace === undefined ? undefined : yield* options.workspace(topic.id);
    const shared: Partial<ObservedTopicState> = {
      baseCheckout: options.repositoryPath(topic.repository),
      ...(workspace === undefined ? {} : { workspace }),
      ...(activity === undefined ? {} : { mainAgentActivity: activity }),
    };
    const absent = (): Partial<ObservedTopicState> => ({
      ...shared,
      worktreePresent: false,
      worktreeClean: null,
      gitOperationState: "none",
      checkedOutBranch: null,
      gitOperationConflict: null,
      orphan: topic.setup.state === "ready",
    });
    if (topic.worktreePath === null) return absent();
    const present = yield* options.git.worktreePresent(topic.worktreePath);
    if (!present) return absent();
    const inspection = yield* options.git.inspectWorktree(topic.worktreePath);
    return {
      ...shared,
      worktreePresent: true,
      worktreeClean: inspection.clean,
      gitOperationState: operationState(inspection),
      checkedOutBranch: inspection.checkedOutBranch ?? null,
      gitOperationConflict: inspection.operation?.conflict ?? null,
      orphan: false,
    };
  });
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
