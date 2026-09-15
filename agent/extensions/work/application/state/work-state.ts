import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type {
  EphemeralAction,
  ObservationDiagnostic,
  ProjectedOperation,
  ProjectedPullRequestObservation,
  ProjectedRepositoryState,
  ProjectedTopicObservation,
  RevisionedProjectedTopic,
  WorkDaemonIdentity,
  WorkDurableProjection,
  WorkObservedProjection,
  WorkSnapshot,
} from "./schema.ts";
import { emptyDurableProjection, emptyObservedProjection } from "./schema.ts";

export interface DurableCommittedChange {
  readonly _tag: "DurableCommitted";
  /** All rows returned by one successful repository transaction. */
  readonly topics?: ProjectionPatch<RevisionedProjectedTopic>;
  readonly repositoryStates?: ProjectionPatch<ProjectedRepositoryState>;
  readonly operations?: ProjectionPatch<ProjectedOperation>;
}

export interface ObservedChangedChange {
  readonly _tag: "ObservedChanged";
  readonly topics?: ProjectionPatch<ProjectedTopicObservation>;
  readonly pullRequests?: ProjectionPatch<ProjectedPullRequestObservation>;
  readonly diagnostics?: ReadonlyArray<ObservationDiagnostic>;
  readonly activeActions?: ReadonlyArray<EphemeralAction>;
}

export type WorkProjectionChange = DurableCommittedChange | ObservedChangedChange;

export interface ProjectionPatch<A> {
  readonly upsert?: ReadonlyArray<A>;
  readonly remove?: ReadonlyArray<string>;
}

export type WorkStreamItem =
  | { readonly _tag: "Snapshot"; readonly snapshot: WorkSnapshot }
  | {
      readonly _tag: "Change";
      readonly daemonId: string;
      readonly revision: number;
      readonly change: WorkProjectionChange;
    }
  | {
      readonly _tag: "ResyncRequired";
      readonly daemonId: string;
      readonly expectedRevision: number;
      readonly actualRevision: number;
    };

export interface WorkSubscription {
  readonly stream: Stream.Stream<WorkStreamItem>;
  readonly close: Effect.Effect<void>;
}

export interface WorkStateProjection {
  /** Returns the current deeply frozen value. */
  readonly snapshot: Effect.Effect<WorkSnapshot>;
  /** Applies and publishes one committed durable batch or one observed-state change. */
  readonly publish: (change: WorkProjectionChange) => Effect.Effect<WorkStreamItem>;
  /** Registers atomically with its first snapshot. The caller must close the subscription. */
  readonly subscribe: (capacity?: number) => Effect.Effect<WorkSubscription>;
  /** Test and operational diagnostic. State policy must not depend on this value. */
  readonly subscriberCount: Effect.Effect<number>;
}

interface Subscriber {
  readonly queue: Queue.Queue<WorkStreamItem, Cause.Done>;
  lastQueuedRevision: number;
}

export interface WorkStateOptions {
  readonly daemon: WorkDaemonIdentity;
  readonly durable?: WorkDurableProjection;
  readonly observed?: WorkObservedProjection;
  readonly subscriberCapacity?: number;
}

const DEFAULT_SUBSCRIBER_CAPACITY = 64;

/**
 * Makes one isolated projection. Its semaphore is the only mutation and registration path,
 * and dropping queues make publication independent of subscriber speed.
 */
export const makeWorkState = (options: WorkStateOptions): Effect.Effect<WorkStateProjection> =>
  Effect.gen(function* () {
    const mutex = yield* Semaphore.make(1);
    const subscribers = new Map<number, Subscriber>();
    let nextSubscriberId = 1;
    let current = freezeSnapshot({
      daemon: options.daemon,
      revision: 0,
      durable: options.durable ?? emptyDurableProjection(),
      observed: options.observed ?? emptyObservedProjection(),
    });
    const defaultCapacity = normalizeCapacity(
      options.subscriberCapacity ?? DEFAULT_SUBSCRIBER_CAPACITY,
    );

    const snapshot = mutex.withPermit(Effect.sync(() => current));

    const publish = (change: WorkProjectionChange): Effect.Effect<WorkStreamItem> =>
      mutex.withPermit(
        Effect.sync(() => {
          const revision = current.revision + 1;
          current = reduceWorkSnapshot(current, change, revision);
          const item = deepFreeze<WorkStreamItem>({
            _tag: "Change",
            daemonId: current.daemon.id,
            revision,
            change,
          });

          for (const [id, subscriber] of subscribers) {
            const queued = Queue.sizeUnsafe(subscriber.queue);
            // One reserved slot remains available for the terminal resync marker.
            if (
              queued >= subscriber.queue.capacity - 1 ||
              !Queue.offerUnsafe(subscriber.queue, item)
            ) {
              const resync = deepFreeze<WorkStreamItem>({
                _tag: "ResyncRequired",
                daemonId: current.daemon.id,
                expectedRevision: subscriber.lastQueuedRevision + 1,
                actualRevision: revision,
              });
              Queue.offerUnsafe(subscriber.queue, resync);
              Queue.endUnsafe(subscriber.queue);
              subscribers.delete(id);
            } else {
              subscriber.lastQueuedRevision = revision;
            }
          }
          return item;
        }),
      );

    const subscribe = (requestedCapacity?: number): Effect.Effect<WorkSubscription> =>
      mutex.withPermit(
        Effect.gen(function* () {
          const capacity = normalizeCapacity(requestedCapacity ?? defaultCapacity);
          // The extra slot is reserved for ResyncRequired and does not expand change capacity.
          const queue = yield* Queue.dropping<WorkStreamItem, Cause.Done>(capacity + 1);
          const id = nextSubscriberId++;
          Queue.offerUnsafe(
            queue,
            deepFreeze<WorkStreamItem>({ _tag: "Snapshot", snapshot: current }),
          );
          subscribers.set(id, { queue, lastQueuedRevision: current.revision });
          const close = mutex.withPermit(
            Effect.gen(function* () {
              subscribers.delete(id);
              yield* Queue.shutdown(queue);
            }),
          );
          return { stream: Stream.fromQueue(queue), close };
        }),
      );

    return {
      snapshot,
      publish,
      subscribe,
      subscriberCount: mutex.withPermit(Effect.sync(() => subscribers.size)),
    };
  });

/** Pure state reduction shared by daemon tests and later non-TUI client projection code. */
export function reduceWorkSnapshot(
  snapshot: WorkSnapshot,
  change: WorkProjectionChange,
  revision: number,
): WorkSnapshot {
  if (change._tag === "DurableCommitted") {
    const topics = applyPatch(snapshot.durable.topics, change.topics, (item) => item.topic.id);
    const removedTopicIds = new Set(change.topics?.remove ?? []);
    return freezeSnapshot({
      ...snapshot,
      revision,
      durable: {
        topics,
        repositoryStates: applyPatch(
          snapshot.durable.repositoryStates,
          change.repositoryStates,
          (item) => item.repository,
        ),
        operations: applyPatch(snapshot.durable.operations, change.operations, (item) => item.id),
      },
      observed:
        removedTopicIds.size === 0
          ? snapshot.observed
          : {
              ...snapshot.observed,
              topics: snapshot.observed.topics.filter((item) => !removedTopicIds.has(item.topicId)),
              pullRequests: snapshot.observed.pullRequests.filter(
                (item) => !removedTopicIds.has(item.topicId),
              ),
              diagnostics: snapshot.observed.diagnostics.filter(
                (item) => item.topicId === undefined || !removedTopicIds.has(item.topicId),
              ),
              activeActions: snapshot.observed.activeActions.filter(
                (item) => item.topicId === undefined || !removedTopicIds.has(item.topicId),
              ),
            },
    });
  }

  return freezeSnapshot({
    ...snapshot,
    revision,
    observed: {
      topics: applyPatch(snapshot.observed.topics, change.topics, (item) => item.topicId),
      pullRequests: applyPatch(
        snapshot.observed.pullRequests,
        change.pullRequests,
        (item) => item.topicId,
      ),
      diagnostics:
        change.diagnostics === undefined ? snapshot.observed.diagnostics : [...change.diagnostics],
      activeActions:
        change.activeActions === undefined
          ? snapshot.observed.activeActions
          : [...change.activeActions],
    },
  });
}

export type WorkStreamCursor =
  | { readonly _tag: "AwaitingSnapshot" }
  | { readonly _tag: "Current"; readonly daemonId: string; readonly revision: number }
  | { readonly _tag: "Resubscribe" };

/** Detects reconnects, explicit resync markers, and missing revisions without TUI dependencies. */
export function advanceWorkStreamCursor(
  cursor: WorkStreamCursor,
  item: WorkStreamItem,
): WorkStreamCursor {
  if (item._tag === "Snapshot") {
    return {
      _tag: "Current",
      daemonId: item.snapshot.daemon.id,
      revision: item.snapshot.revision,
    };
  }
  if (item._tag === "ResyncRequired" || cursor._tag !== "Current") {
    return { _tag: "Resubscribe" };
  }
  return item.daemonId === cursor.daemonId && item.revision === cursor.revision + 1
    ? { _tag: "Current", daemonId: cursor.daemonId, revision: item.revision }
    : { _tag: "Resubscribe" };
}

function applyPatch<A>(
  values: ReadonlyArray<A>,
  patch: ProjectionPatch<A> | undefined,
  key: (value: A) => string,
): ReadonlyArray<A> {
  if (patch === undefined) return values;
  const byKey = new Map(values.map((value) => [key(value), value]));
  for (const removed of patch.remove ?? []) byKey.delete(removed);
  for (const value of patch.upsert ?? []) byKey.set(key(value), value);
  return [...byKey.values()].toSorted((left, right) => key(left).localeCompare(key(right)));
}

function normalizeCapacity(capacity: number): number {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
    throw new RangeError("Work subscription capacity must be an integer from 1 through 10000.");
  }
  return capacity;
}

function freezeSnapshot(snapshot: WorkSnapshot): WorkSnapshot {
  return deepFreeze(snapshot);
}

function deepFreeze<A>(value: A): A {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
