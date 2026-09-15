import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  OperationFailure,
  OperationId,
  PolicyFailure,
  type ClientId,
  type DurableOperationInput,
  type DurableOperationResult,
  type PrivateLocalCapability as Capability,
  type PublicWorkFailure,
  type RequestId,
  type StorageFailure,
  type TopicId,
} from "../../domain/index.ts";
import type { DurableOperation, OperationRepository } from "./repository.ts";
import type { ProjectedOperation, WorkStateProjection } from "../state/index.ts";

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
const MAX_PHASE_LENGTH = 100;

export interface OperationHandle {
  readonly id: OperationId;
  readonly state: DurableOperation["state"];
  /** Present only in the direct response that creates a confirmation. */
  readonly confirmation?: Capability;
}

export interface OperationStart {
  readonly clientId: ClientId;
  readonly requestId: RequestId;
  readonly fingerprint: string;
  readonly input: DurableOperationInput;
  readonly topicId?: TopicId;
  readonly phase?: string;
  readonly confirmation?: {
    readonly action: string;
    readonly lifetimeMs: number;
    readonly durable: boolean;
  };
}

export interface OperationWorkerContext {
  readonly operation: DurableOperation;
  readonly progress: (phase: string) => Effect.Effect<void, StorageFailure | OperationFailure>;
}

export interface OperationWorker {
  /** Running work with this input kind can continue from its durable checkpoints. */
  readonly resumable: boolean;
  readonly run: (
    context: OperationWorkerContext,
  ) => Effect.Effect<DurableOperationResult, PublicWorkFailure>;
  /** Reconciles durable subject state after a running Setup command lost supervision. */
  readonly interrupted?: (
    operation: DurableOperation,
  ) => Effect.Effect<void, StorageFailure | OperationFailure>;
}

export interface OperationWatch {
  readonly stream: Stream.Stream<DurableOperation, StorageFailure | OperationFailure>;
  readonly close: Effect.Effect<void>;
}

export interface OperationEngine {
  readonly start: (
    request: OperationStart,
  ) => Effect.Effect<OperationHandle, StorageFailure | OperationFailure>;
  readonly get: (
    id: OperationId,
  ) => Effect.Effect<DurableOperation, StorageFailure | OperationFailure>;
  readonly watch: (
    id: OperationId,
  ) => Effect.Effect<OperationWatch, StorageFailure | OperationFailure>;
  readonly await: (
    id: OperationId,
  ) => Effect.Effect<DurableOperation, StorageFailure | OperationFailure>;
  readonly requestCancellation: (
    id: OperationId,
    lifetimeMs: number,
    durable?: boolean,
  ) => Effect.Effect<Capability, StorageFailure | OperationFailure>;
  readonly confirm: (
    id: OperationId,
    capability: Capability,
  ) => Effect.Effect<DurableOperation, StorageFailure | OperationFailure | PolicyFailure>;
  readonly reject: (
    id: OperationId,
  ) => Effect.Effect<DurableOperation, StorageFailure | OperationFailure>;
  readonly executeAtomicCommand: <E, R>(
    input: {
      readonly clientId: ClientId;
      readonly requestId: RequestId;
      readonly fingerprint: string;
    },
    command: Effect.Effect<DurableOperationResult, E, R>,
  ) => Effect.Effect<DurableOperationResult, E | StorageFailure | OperationFailure, R>;
  readonly recover: Effect.Effect<void, StorageFailure | OperationFailure>;
  readonly activeWorkerCount: Effect.Effect<number>;
}

export interface OperationEngineOptions {
  readonly repository: OperationRepository;
  readonly state: WorkStateProjection;
  readonly workers: Readonly<Record<string, OperationWorker>>;
  readonly makeOperationId?: () => OperationId;
  readonly makeCapability?: () => Capability;
  readonly retentionIntervalMs?: number;
  readonly reportDefect?: (
    operationId: OperationId,
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>;
}

interface EphemeralConfirmation {
  readonly capability: Capability;
  readonly action: string;
  readonly expiresAt: number;
}

/** Makes one daemon-scoped engine. All operation and deadline fibers belong to the calling Scope. */
export const makeOperationEngine = (
  options: OperationEngineOptions,
): Effect.Effect<OperationEngine, never, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const workers = yield* FiberMap.make<OperationId>();
    const deadlines = yield* FiberMap.make<OperationId>();
    const commandMutex = yield* Semaphore.make(1);
    const ephemeral = new Map<OperationId, EphemeralConfirmation>();
    const reportDefect = options.reportDefect ?? (() => Effect.void);

    const nowMillis = Clock.currentTimeMillis;
    const nowIso = nowMillis.pipe(Effect.map((value) => new Date(value).toISOString()));
    const publish = (operation: DurableOperation) =>
      options.state
        .publish({
          _tag: "DurableCommitted",
          operations: { upsert: [project(operation)] },
        })
        .pipe(Effect.asVoid);

    const transition = (
      operation: DurableOperation,
      state: DurableOperation["state"],
      phase: string,
      result?: DurableOperationResult,
    ) =>
      Effect.gen(function* () {
        const updated = yield* options.repository.transition({
          id: operation.id,
          expectedState: operation.state,
          expectedRevision: operation.revision,
          state,
          phase: boundPhase(phase),
          now: yield* nowIso,
          ...(result === undefined ? {} : { result }),
        });
        yield* publish(updated);
        return updated;
      });

    const finishFailure = (operationId: OperationId, cause: Cause.Cause<PublicWorkFailure>) =>
      Effect.gen(function* () {
        if (Cause.hasInterruptsOnly(cause)) return;
        const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (failure === undefined) yield* reportDefect(operationId, cause);
        const operation = yield* options.repository.get(operationId);
        if (terminalStates.has(operation.state)) return;
        const value =
          failure === undefined
            ? { reason: "internal", message: "The operation failed because of an internal error." }
            : { reason: failure.reason, message: failure.message };
        yield* transition(operation, "failed", "failed", {
          version: 1,
          status: "failed",
          value,
        });
      }).pipe(Effect.catch(() => Effect.void));

    const runWorker = (operation: DurableOperation, alreadyRunning = false) => {
      const worker = options.workers[operation.input.kind];
      if (worker === undefined) {
        return transition(operation, "failed", "unsupported-operation", {
          version: 1,
          status: "failed",
          value: { reason: "unsupported-operation" },
        }).pipe(Effect.asVoid);
      }
      const effect = Effect.gen(function* () {
        const running = alreadyRunning
          ? operation
          : yield* transition(operation, "running", "running");
        const result = yield* worker.run({
          operation: running,
          progress: (phase) =>
            Effect.gen(function* () {
              const current = yield* options.repository.get(operation.id);
              if (current.state !== "running")
                return yield* Effect.fail(
                  new OperationFailure({
                    reason: "invalid-state",
                    message: "Operation progress is not valid in the current state.",
                    details: { operationId: operation.id },
                  }),
                );
              yield* transition(current, "running", phase);
            }),
        });
        const current = yield* options.repository.get(operation.id);
        if (!terminalStates.has(current.state)) {
          yield* transition(current, result.status, result.status, result);
        }
      }).pipe(Effect.catchCause((cause) => finishFailure(operation.id, cause)));
      return FiberMap.run(workers, operation.id, effect, { onlyIfMissing: true }).pipe(
        Effect.asVoid,
      );
    };

    const expire = (id: OperationId, expiresAt: number, durable: boolean) =>
      FiberMap.run(
        deadlines,
        id,
        Effect.gen(function* () {
          const currentTime = yield* nowMillis;
          if (expiresAt > currentTime) yield* Effect.sleep(expiresAt - currentTime);
          const now = yield* nowIso;
          if (durable) yield* options.repository.expireOperationConfirmation(id, now);
          else ephemeral.delete(id);
          const operation = yield* options.repository.get(id);
          if (operation.state === "awaiting-confirmation") {
            yield* transition(operation, "failed", "confirmation-expired", {
              version: 1,
              status: "failed",
              value: { reason: "confirmation-expired" },
            });
          }
        }).pipe(Effect.catch(() => Effect.void)),
        { onlyIfMissing: false },
      ).pipe(Effect.asVoid);

    const createConfirmation = (
      operation: DurableOperation,
      action: string,
      lifetimeMs: number,
      durable: boolean,
    ) =>
      Effect.gen(function* () {
        const capability = (options.makeCapability ?? defaultCapability)();
        const currentTime = yield* nowMillis;
        const expiresAt = currentTime + normalizeLifetime(lifetimeMs);
        if (durable) {
          yield* options.repository.createConfirmation({
            capability,
            operationId: operation.id,
            action: boundPhase(action),
            expiresAt: new Date(expiresAt).toISOString(),
          });
        } else {
          ephemeral.set(operation.id, { capability, action, expiresAt });
        }
        yield* expire(operation.id, expiresAt, durable);
        return capability;
      });

    const recover = Effect.gen(function* () {
      const now = yield* nowIso;
      const interrupted = yield* options.repository.recoverInterruptedSetup(now);
      for (const id of interrupted) {
        const operation = yield* options.repository.get(id);
        yield* options.workers[operation.input.kind]?.interrupted?.(operation) ?? Effect.void;
        yield* publish(yield* options.repository.get(id));
      }
      const pending = yield* options.repository.listPendingConfirmations();
      const durablePending = new Set(pending.map((item) => item.operationId));
      for (const item of pending) {
        yield* expire(item.operationId, Date.parse(item.expiresAt), true);
      }
      for (const operation of yield* options.repository.listActive()) {
        yield* publish(operation);
        if (operation.state === "awaiting-confirmation") {
          if (!durablePending.has(operation.id)) {
            yield* transition(operation, "failed", "confirmation-lost", {
              version: 1,
              status: "failed",
              value: { reason: "confirmation-lost" },
            });
          }
          continue;
        }
        if (operation.state === "setup-interrupted") continue;
        const worker = options.workers[operation.input.kind];
        if (worker?.resumable === true) {
          yield* runWorker(operation, operation.state === "running");
        }
      }
    });

    const start = (request: OperationStart) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const claim = yield* options.repository.claim({
          id: (options.makeOperationId ?? defaultOperationId)(),
          clientId: request.clientId,
          requestId: request.requestId,
          fingerprint: request.fingerprint,
          ...(request.topicId === undefined ? {} : { topicId: request.topicId }),
          operationInput: request.input,
          phase: boundPhase(request.phase ?? "accepted"),
          now,
        });
        let operation = claim.operation;
        yield* publish(operation);
        if (!claim.claimed || terminalStates.has(operation.state)) {
          return { id: operation.id, state: operation.state };
        }
        if (request.confirmation !== undefined) {
          operation = yield* transition(
            operation,
            "awaiting-confirmation",
            "awaiting-confirmation",
          );
          const confirmation = yield* createConfirmation(
            operation,
            request.confirmation.action,
            request.confirmation.lifetimeMs,
            request.confirmation.durable,
          );
          return { id: operation.id, state: operation.state, confirmation };
        }
        yield* runWorker(operation);
        return { id: operation.id, state: operation.state };
      });

    const watch = (id: OperationId) =>
      Effect.gen(function* () {
        yield* options.repository.get(id);
        const subscription = yield* options.state.subscribe();
        const stream = subscription.stream.pipe(
          Stream.map((item) => {
            if (item._tag === "Snapshot") {
              return item.snapshot.durable.operations.some((value) => value.id === id);
            }
            return (
              item._tag === "Change" &&
              item.change._tag === "DurableCommitted" &&
              item.change.operations?.upsert?.some((value) => value.id === id) === true
            );
          }),
          Stream.filter((changed) => changed),
          Stream.mapEffect(() => options.repository.get(id)),
          Stream.ensuring(subscription.close),
        );
        return { stream, close: subscription.close };
      });

    const awaitOperation = (id: OperationId) =>
      Effect.gen(function* () {
        const initial = yield* options.repository.get(id);
        if (terminalStates.has(initial.state)) return initial;
        const watched = yield* watch(id);
        const found = yield* watched.stream.pipe(
          Stream.filter((operation) => terminalStates.has(operation.state)),
          Stream.runHead,
        );
        return Option.getOrElse(found, () => initial);
      });

    const requestCancellation = (id: OperationId, lifetimeMs: number, durable = true) =>
      Effect.gen(function* () {
        const operation = yield* options.repository.get(id);
        if (terminalStates.has(operation.state)) return yield* Effect.fail(alreadyTerminal(id));
        return yield* createConfirmation(operation, "operation.cancel", lifetimeMs, durable);
      });

    const confirm = (id: OperationId, capability: Capability) =>
      Effect.gen(function* () {
        const nowMs = yield* nowMillis;
        let consumed:
          | { readonly status: "consumed"; readonly action: string }
          | { readonly status: "expired"; readonly action: string }
          | { readonly status: "invalid" };
        const memory = ephemeral.get(id);
        if (memory !== undefined && sameCapability(memory.capability, capability)) {
          ephemeral.delete(id);
          consumed =
            memory.expiresAt <= nowMs
              ? { status: "expired", action: memory.action }
              : { status: "consumed", action: memory.action };
        } else {
          consumed = yield* options.repository.consumeOperationConfirmation(
            id,
            capability,
            new Date(nowMs).toISOString(),
          );
        }
        if (consumed.status === "invalid")
          return yield* Effect.fail(
            new PolicyFailure({ reason: "denied", message: "Confirmation is not valid." }),
          );
        if (consumed.status === "expired")
          return yield* Effect.fail(
            new PolicyFailure({
              reason: "confirmation-expired",
              message: "Confirmation expired.",
              details: { operationId: id },
            }),
          );
        yield* FiberMap.remove(deadlines, id);
        const operation = yield* options.repository.get(id);
        if (consumed.action === "operation.cancel") {
          yield* FiberMap.remove(workers, id);
          const current = yield* options.repository.get(id);
          if (terminalStates.has(current.state)) return current;
          return yield* transition(current, "cancelled", "cancelled", {
            version: 1,
            status: "cancelled",
            value: { reason: "cancelled-by-user" },
          });
        }
        if (operation.state !== "awaiting-confirmation")
          return yield* Effect.fail(alreadyTerminal(id));
        const running = yield* transition(operation, "running", "running");
        yield* runWorker(running, true);
        return running;
      });

    const reject = (id: OperationId) =>
      Effect.gen(function* () {
        yield* FiberMap.remove(deadlines, id);
        ephemeral.delete(id);
        const operation = yield* options.repository.get(id);
        if (operation.state !== "awaiting-confirmation")
          return yield* Effect.fail(
            new OperationFailure({
              reason: "invalid-state",
              message: "Operation is not awaiting confirmation.",
              details: { operationId: id },
            }),
          );
        return yield* transition(operation, "cancelled", "rejected", {
          version: 1,
          status: "cancelled",
          value: { reason: "confirmation-rejected" },
        });
      });

    const executeAtomicCommand: OperationEngine["executeAtomicCommand"] = (input, command) =>
      commandMutex.withPermit(
        Effect.gen(function* () {
          const replay = yield* options.repository.replayCommandResult(input);
          if (replay !== undefined) return replay;
          const result = yield* command;
          return (yield* options.repository.storeCommandResult({
            ...input,
            result,
            now: yield* nowIso,
          })).result;
        }),
      );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.sleep(options.retentionIntervalMs ?? 60 * 60 * 1_000).pipe(
          Effect.andThen(nowIso),
          Effect.flatMap((now) => options.repository.pruneTerminalResults(now)),
          Effect.catch(() => Effect.void),
        ),
      ),
    );

    return {
      start,
      get: options.repository.get,
      watch,
      await: awaitOperation,
      requestCancellation,
      confirm,
      reject,
      executeAtomicCommand,
      recover,
      activeWorkerCount: FiberMap.size(workers),
    };
  });

function project(operation: DurableOperation): ProjectedOperation {
  return {
    id: operation.id,
    ...(operation.topicId === undefined ? {} : { topicId: operation.topicId }),
    state: operation.state,
    phase: operation.phase,
    input: operation.input,
    ...(operation.result === undefined ? {} : { result: operation.result }),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.terminalAt === undefined ? {} : { terminalAt: operation.terminalAt }),
    rowRevision: operation.revision,
  };
}

function defaultOperationId(): OperationId {
  return Schema.decodeUnknownSync(OperationId)(globalThis.crypto.randomUUID());
}

function defaultCapability(): Capability {
  return Redacted.make(`work-confirmation-${globalThis.crypto.randomUUID()}`);
}

function sameCapability(left: Capability, right: Capability): boolean {
  return Redacted.value(left) === Redacted.value(right);
}

function normalizeLifetime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24 * 60 * 60 * 1_000) {
    throw new RangeError("Confirmation lifetime must be from 1 ms through 24 hours.");
  }
  return value;
}

function boundPhase(value: string): string {
  const phase = value.replaceAll(/\s+/g, " ").trim();
  return (phase.length === 0 ? "running" : phase).slice(0, MAX_PHASE_LENGTH);
}

function alreadyTerminal(id: OperationId): OperationFailure {
  return new OperationFailure({
    reason: "already-terminal",
    message: "Operation is already terminal.",
    details: { operationId: id },
  });
}
