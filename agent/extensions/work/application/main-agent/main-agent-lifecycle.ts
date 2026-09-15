import { randomBytes, randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import {
  DomainFailure,
  MainAgentFailure,
  PrivateLocalCapability,
  type AbsolutePath,
  type MainAgentActivity,
  type PrivateLocalCapability as Capability,
  type PublicWorkFailure,
  type TopicId,
} from "../../domain/index.ts";
import type {
  MainAgentActionResult,
  MainAgentLaunch,
  CloseMainAgentResult,
} from "../../infrastructure/desktop/index.ts";
import type {
  OperationRepositoryService,
  RevisionedTopic,
  TopicRepositoryService,
} from "../../infrastructure/storage/index.ts";
import type { WorkStateProjection } from "../state/index.ts";

const DEFAULT_REGISTRATION_TTL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

export interface MainAgentLease {
  readonly topicId: TopicId;
  readonly sessionId: string;
  readonly activity: MainAgentActivity;
  readonly connected: boolean;
  readonly reason?: string;
}

interface LiveLease extends MainAgentLease {
  readonly connectionId?: string;
  readonly heartbeatGeneration: number;
}

export interface MainAgentDesktop<R = never> {
  readonly openMainAgent: (
    launch: MainAgentLaunch,
  ) => Effect.Effect<MainAgentActionResult, PublicWorkFailure, R>;
  readonly closeMainAgent: (
    topicId: TopicId,
  ) => Effect.Effect<CloseMainAgentResult, PublicWorkFailure, R>;
}

export interface MainAgentLifecycleOptions<R = never> {
  readonly topics: TopicRepositoryService;
  readonly capabilities: OperationRepositoryService;
  readonly state: WorkStateProjection;
  readonly desktop: MainAgentDesktop<R>;
  readonly socketPath: AbsolutePath;
  readonly registrationTtlMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly makeCapability?: () => Capability;
  readonly makeSessionId?: () => string;
  readonly now?: Effect.Effect<number>;
}

interface MainAgentConnectionIdentity {
  readonly connectionId: string;
  readonly topicId: TopicId;
  readonly sessionId: string;
  readonly sessionFile: AbsolutePath;
}

export interface MainAgentRegistration extends MainAgentConnectionIdentity {
  readonly registration: Capability;
}

export interface MainAgentAdoption extends MainAgentConnectionIdentity {
  readonly affiliation: Capability;
}

export interface MainAgentLifecycle<R = never> {
  readonly snapshot: Effect.Effect<ReadonlyArray<MainAgentLease>>;
  readonly open: (topicId: TopicId) => Effect.Effect<MainAgentActionResult, PublicWorkFailure, R>;
  readonly reset: (topicId: TopicId) => Effect.Effect<MainAgentActionResult, PublicWorkFailure, R>;
  readonly register: (
    input: MainAgentRegistration,
  ) => Effect.Effect<MainAgentLease, PublicWorkFailure>;
  readonly adopt: (input: MainAgentAdoption) => Effect.Effect<MainAgentLease, PublicWorkFailure>;
  readonly heartbeat: (connectionId: string) => Effect.Effect<MainAgentLease, MainAgentFailure>;
  readonly report: (
    connectionId: string,
    activity: Exclude<MainAgentActivity, "starting" | "idle" | "failed">,
  ) => Effect.Effect<MainAgentLease, MainAgentFailure>;
  readonly disconnected: (connectionId: string) => Effect.Effect<void>;
}

/**
 * Owns durable Main Agent credentials and live leases. It never reads a Pi session file.
 * The scope that constructs this module owns all heartbeat deadline fibers.
 */
export const makeMainAgentLifecycle = <R>(
  options: MainAgentLifecycleOptions<R>,
): Effect.Effect<MainAgentLifecycle<R>, PublicWorkFailure, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const mutex = yield* Semaphore.make(1);
    const leases = new Map<TopicId, LiveLease>();
    const registrationTtl = options.registrationTtlMs ?? DEFAULT_REGISTRATION_TTL_MS;
    const heartbeatTimeout = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    const now = options.now ?? Clock.currentTimeMillis;
    const makeCapability = options.makeCapability ?? defaultCapability;
    const makeSessionId = options.makeSessionId ?? randomUUID;

    const initial = yield* options.topics.list;
    for (const row of initial) {
      leases.set(row.topic.id, {
        topicId: row.topic.id,
        sessionId: row.topic.mainAgent.sessionId,
        activity: "stopped",
        connected: false,
        heartbeatGeneration: 0,
      });
    }

    const publishLease = (lease: LiveLease) =>
      Effect.gen(function* () {
        const snapshot = yield* options.state.snapshot;
        const old = snapshot.observed.topics.find((item) => item.topicId === lease.topicId);
        const value = {
          topicId: lease.topicId,
          integrationStatus: old?.value?.integrationStatus ?? "unknown",
          gitOperationState: old?.value?.gitOperationState ?? "unknown",
          worktreePresent: old?.value?.worktreePresent ?? false,
          worktreeClean: old?.value?.worktreeClean ?? null,
          orphan: old?.value?.orphan ?? false,
          mainAgentActivity: lease.activity,
        } as const;
        yield* options.state.publish({
          _tag: "ObservedChanged",
          topics: {
            upsert: [
              {
                topicId: lease.topicId,
                freshness: old?.freshness ?? { _tag: "Unknown" },
                value,
              },
            ],
          },
        });
      });

    for (const lease of leases.values()) yield* publishLease(lease);

    const publicLease = (lease: LiveLease): MainAgentLease => ({
      topicId: lease.topicId,
      sessionId: lease.sessionId,
      activity: lease.activity,
      connected: lease.connected,
      ...(lease.reason === undefined ? {} : { reason: lease.reason }),
    });

    const replace = (lease: LiveLease) =>
      Effect.gen(function* () {
        leases.set(lease.topicId, lease);
        yield* publishLease(lease);
        return publicLease(lease);
      });

    const findConnection = (connectionId: string): LiveLease | undefined =>
      [...leases.values()].find((lease) => lease.connected && lease.connectionId === connectionId);

    const missingConnection = () =>
      new MainAgentFailure({
        reason: "not-registered",
        message: "The Main Agent connection is not registered.",
      });

    const armHeartbeatDeadline = (lease: LiveLease) =>
      Effect.forkIn(
        Effect.sleep(heartbeatTimeout).pipe(
          Effect.andThen(
            mutex.withPermit(
              Effect.gen(function* () {
                const current = leases.get(lease.topicId);
                if (
                  current?.connected !== true ||
                  current.heartbeatGeneration !== lease.heartbeatGeneration
                ) {
                  return;
                }
                yield* replace({
                  topicId: current.topicId,
                  sessionId: current.sessionId,
                  activity: "failed",
                  connected: false,
                  heartbeatGeneration: current.heartbeatGeneration,
                  reason: "Main Agent heartbeat expired.",
                });
              }),
            ),
          ),
        ),
        scope,
      ).pipe(Effect.asVoid);

    const currentTopic = (topicId: TopicId) => options.topics.get(topicId);

    const publishDurable = (topic: RevisionedTopic) =>
      options.state
        .publish({
          _tag: "DurableCommitted",
          topics: { upsert: [{ topic: topic.topic, rowRevision: topic.revision }] },
        })
        .pipe(Effect.asVoid);

    const launch = (row: RevisionedTopic) =>
      Effect.gen(function* () {
        if (row.topic.worktreePath === null) {
          return yield* Effect.fail(
            new DomainFailure({
              reason: "invalid-topic",
              message: "The Topic has no Worktree for a Main Agent.",
              details: { topicId: row.topic.id },
            }),
          );
        }
        const registration = makeCapability();
        const affiliation = makeCapability();
        const startedAt = yield* now;
        const started = new Date(startedAt).toISOString();
        yield* options.capabilities.storeCapability({
          capability: registration,
          kind: "registration",
          topicId: row.topic.id,
          expiresAt: new Date(startedAt + registrationTtl).toISOString(),
          now: started,
        });
        yield* options.capabilities.storeCapability({
          capability: affiliation,
          kind: "affiliation",
          topicId: row.topic.id,
          now: started,
        });
        yield* replace({
          topicId: row.topic.id,
          sessionId: row.topic.mainAgent.sessionId,
          activity: "starting",
          connected: false,
          heartbeatGeneration: 0,
        });
        const result = yield* options.desktop.openMainAgent({
          topicId: row.topic.id,
          topicName: row.topic.name,
          worktreePath: row.topic.worktreePath,
          sessionId: row.topic.mainAgent.sessionId,
          socketPath: options.socketPath,
          registrationToken: registration,
          affiliationToken: affiliation,
        });
        if (result.kind === "unavailable") {
          yield* options.capabilities.revokeTopicCapabilities(row.topic.id);
          yield* replace({
            topicId: row.topic.id,
            sessionId: row.topic.mainAgent.sessionId,
            activity: "failed",
            connected: false,
            heartbeatGeneration: 0,
            reason: result.message,
          });
        }
        return result;
      });

    const open = (topicId: TopicId) => currentTopic(topicId).pipe(Effect.flatMap(launch));

    const reset = (topicId: TopicId) =>
      Effect.gen(function* () {
        const row = yield* currentTopic(topicId);
        // Rotation happens before desktop launch, so an old window cannot adopt the new identity.
        yield* options.capabilities.revokeTopicCapabilities(topicId);
        const closed = yield* options.desktop.closeMainAgent(topicId);
        if (closed.kind === "unavailable") return closed;
        const identity = { sessionId: makeSessionId(), sessionFile: null } as const;
        const updated = yield* options.topics.updateMainAgent(topicId, identity, row.revision);
        yield* publishDurable(updated);
        yield* replace({
          topicId,
          sessionId: identity.sessionId,
          activity: "stopped",
          connected: false,
          heartbeatGeneration: 0,
        });
        return yield* launch(updated);
      });

    const connect = (input: MainAgentRegistration | MainAgentAdoption) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const row = yield* currentTopic(input.topicId);
          const current = leases.get(input.topicId);
          const instant = new Date(yield* now).toISOString();
          const exact = row.topic.mainAgent.sessionId === input.sessionId;

          if ("registration" in input) {
            if (!exact) {
              return yield* Effect.fail(
                new MainAgentFailure({
                  reason: "invalid-identity",
                  message: "The Main Agent identity does not match this Topic.",
                  details: { topicId: input.topicId },
                }),
              );
            }
            if (current?.connected === true && current.connectionId !== input.connectionId) {
              return yield* Effect.fail(
                new MainAgentFailure({
                  reason: "already-connected",
                  message: "A Main Agent is already connected for this Topic.",
                  details: { topicId: input.topicId },
                }),
              );
            }
            const consumed = yield* options.capabilities.consumeRegistration(
              input.registration,
              input.topicId,
              instant,
            );
            if (!consumed) {
              return yield* Effect.fail(
                new MainAgentFailure({
                  reason: "invalid-registration",
                  message: "The Main Agent registration is invalid or expired.",
                  details: { topicId: input.topicId },
                }),
              );
            }
          } else {
            const affiliated = yield* options.capabilities.verifyCapability(
              input.affiliation,
              "affiliation",
              input.topicId,
              instant,
            );
            if (!affiliated) {
              return yield* Effect.fail(
                new MainAgentFailure({
                  reason: "invalid-identity",
                  message: "The Main Agent affiliation does not match this Topic.",
                  details: { topicId: input.topicId },
                }),
              );
            }
          }

          let durable = row;
          if (
            !exact ||
            row.topic.mainAgent.sessionFile === null ||
            row.topic.mainAgent.sessionFile !== input.sessionFile
          ) {
            durable = yield* options.topics.updateMainAgent(
              input.topicId,
              { sessionId: input.sessionId, sessionFile: input.sessionFile },
              row.revision,
            );
            yield* publishDurable(durable);
          }
          const generation = (current?.heartbeatGeneration ?? 0) + 1;
          const lease: LiveLease = {
            topicId: input.topicId,
            sessionId: durable.topic.mainAgent.sessionId,
            activity: "idle",
            connected: true,
            connectionId: input.connectionId,
            heartbeatGeneration: generation,
          };
          const result = yield* replace(lease);
          yield* armHeartbeatDeadline(lease);
          return result;
        }),
      );

    const register = (input: MainAgentRegistration) => connect(input);
    const adopt = (input: MainAgentAdoption) => connect(input);

    const heartbeat = (connectionId: string) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const current = findConnection(connectionId);
          if (current === undefined) return yield* Effect.fail(missingConnection());
          const lease = { ...current, heartbeatGeneration: current.heartbeatGeneration + 1 };
          leases.set(lease.topicId, lease);
          yield* armHeartbeatDeadline(lease);
          return publicLease(lease);
        }),
      );

    const report = (
      connectionId: string,
      activity: Exclude<MainAgentActivity, "starting" | "idle" | "failed">,
    ) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const current = findConnection(connectionId);
          if (current === undefined) return yield* Effect.fail(missingConnection());
          if (activity === "stopped") {
            return yield* replace({
              topicId: current.topicId,
              sessionId: current.sessionId,
              activity,
              connected: false,
              heartbeatGeneration: current.heartbeatGeneration,
            });
          }
          return yield* replace({ ...current, activity });
        }),
      );

    const disconnected = (connectionId: string) =>
      mutex.withPermit(
        Effect.sync(() => {
          // A transport disconnect does not end the lease. Its exact deadline does.
          void findConnection(connectionId);
        }),
      );

    return {
      snapshot: mutex.withPermit(
        Effect.sync(() =>
          [...leases.values()]
            .map(publicLease)
            .toSorted((left, right) => left.topicId.localeCompare(right.topicId)),
        ),
      ),
      open,
      reset,
      register,
      adopt,
      heartbeat,
      report,
      disconnected,
    };
  });

function defaultCapability(): Capability {
  return Schema.decodeUnknownSync(PrivateLocalCapability)(randomBytes(32).toString("base64url"));
}
