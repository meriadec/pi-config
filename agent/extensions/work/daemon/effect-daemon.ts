import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { RpcFailure, type PublicWorkFailure } from "../domain/index.ts";
import {
  acquireDaemonRuntime,
  secureBoundSocket,
  workRpcServerLayer,
  type DaemonRuntimeLease,
  type DaemonRuntimeOptions,
  type WorkRpcApplication,
} from "../infrastructure/rpc/index.ts";

export const DEFAULT_DAEMON_SHUTDOWN_DEADLINE_MS = 10_000;

export interface DaemonShutdown {
  readonly stopAccepting: Effect.Effect<void>;
  readonly stopSchedules: Effect.Effect<void>;
  readonly drainAtomicCommands: Effect.Effect<void>;
  readonly closeClientWaits: Effect.Effect<void>;
  readonly interruptEphemeralActions: Effect.Effect<void>;
  readonly checkpointDurableOperations: Effect.Effect<void>;
  readonly terminateProcesses: Effect.Effect<void>;
}

export interface EffectWorkDaemonOptions extends DaemonRuntimeOptions {
  /** Storage, recovery, projection hydration, and application adapters are made after the lock. */
  readonly makeApplication: (
    lease: DaemonRuntimeLease,
  ) => Effect.Effect<WorkRpcApplication, PublicWorkFailure, Scope.Scope>;
  /** Marks the compatibility state ready, then starts non-readiness-blocking observation schedules. */
  readonly ready?: Effect.Effect<void, PublicWorkFailure>;
  /** Publishes stopping after new application work is refused. */
  readonly stopping?: Effect.Effect<void>;
  /** Explicit PRD shutdown stages. Socket, storage, and lock then close by Scope order. */
  readonly shutdown?: DaemonShutdown;
  readonly shutdownDeadlineMs?: number;
  readonly reportDefect?: (
    correlationId: string,
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>;
}

/**
 * The new production-independent daemon program. Its caller supplies one Scope. Acquisition order
 * is lock, storage/application, socket, readiness. Scope release reverses that order and releases
 * the lifetime lock last.
 */
export function makeEffectWorkDaemon(
  options: EffectWorkDaemonOptions,
): Effect.Effect<never, PublicWorkFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const lease = yield* acquireDaemonRuntime(options);
    const application = yield* options.makeApplication(lease);
    const server = workRpcServerLayer({
      socketPath: lease.socketPath,
      application,
      ...(options.reportDefect === undefined ? {} : { reportDefect: options.reportDefect }),
    });
    yield* Layer.build(server).pipe(
      Effect.mapError(
        (cause) =>
          new RpcFailure({
            reason: "unavailable",
            message: "The Work RPC socket could not start.",
            internalCause: cause,
          }),
      ),
    );
    yield* secureBoundSocket(lease.socketPath);
    yield* options.ready ?? Effect.void;
    return yield* Effect.never;
  }).pipe(Effect.ensuring(Effect.uninterruptible(boundedShutdown(options))));
}

function boundedShutdown(options: EffectWorkDaemonOptions): Effect.Effect<void> {
  const stages = options.shutdown;
  const cleanup = (stages?.stopAccepting ?? Effect.void).pipe(
    Effect.andThen(options.stopping ?? Effect.void),
    Effect.andThen(stages?.stopSchedules ?? Effect.void),
    Effect.andThen(stages?.drainAtomicCommands ?? Effect.void),
    Effect.andThen(stages?.closeClientWaits ?? Effect.void),
    Effect.andThen(stages?.interruptEphemeralActions ?? Effect.void),
    Effect.andThen(stages?.checkpointDurableOperations ?? Effect.void),
    Effect.andThen(stages?.terminateProcesses ?? Effect.void),
    Effect.catchCause((cause) => options.reportDefect?.("daemon-shutdown", cause) ?? Effect.void),
  );
  return Effect.raceFirst(
    cleanup,
    Effect.sleep(options.shutdownDeadlineMs ?? DEFAULT_DAEMON_SHUTDOWN_DEADLINE_MS),
  );
}
