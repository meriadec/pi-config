import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import {
  ClientId,
  type DurableOperationResult,
  type OperationId,
  type RequestId,
  type TopicId,
} from "../domain/index.ts";
import type { WorkSnapshot, WorkStreamItem } from "../application/state/index.ts";
import {
  WorkRpcClient,
  workRpcClientLayer,
  type Compatibility,
  type DurableOperation,
  type OperationHandle,
  type StartOperationRequest,
  type TopicCommand,
} from "../infrastructure/rpc/index.ts";

export interface WorkClientRuntimeOptions {
  readonly socketPath: string;
  readonly clientId?: ClientId;
  readonly reconnectDelayMs?: number;
  readonly onTransientError?: (error: unknown) => void;
}

/** Promise and callback bridge for Pi, CLI, and TUI edges. */
export interface WorkClientRuntime {
  readonly clientId: ClientId;
  readonly compatibility: () => Promise<Compatibility>;
  readonly snapshot: () => Promise<WorkSnapshot>;
  readonly startOperation: (request: StartOperationRequest) => Promise<OperationHandle>;
  readonly getOperation: (id: OperationId) => Promise<DurableOperation>;
  readonly awaitOperation: (id: OperationId) => Promise<DurableOperation>;
  readonly startAndAwait: (request: StartOperationRequest) => Promise<DurableOperation>;
  readonly requestOperationCancellation: (
    id: OperationId,
    confirmationLifetimeMs: number,
  ) => Promise<{ readonly confirmation: string }>;
  readonly confirmOperation: (id: OperationId, confirmation: string) => Promise<DurableOperation>;
  readonly rejectOperation: (id: OperationId) => Promise<DurableOperation>;
  readonly atomicCommand: (
    command: TopicCommand,
    requestId?: RequestId,
  ) => Promise<DurableOperationResult>;
  readonly mainAgentCall: (
    request: import("../infrastructure/rpc/client.ts").MainAgentCallRequest,
  ) => Promise<unknown>;
  readonly ephemeralAction: (
    action: "refresh" | "refresh-local" | "refresh-pull-requests" | "rebase",
    topicId?: TopicId,
  ) => Promise<void>;
  /** Starts one supervised state fiber. The returned function interrupts only this subscription. */
  readonly subscribeState: (
    onItem: (item: WorkStreamItem) => void,
    onError?: (error: unknown) => void,
    capacity?: number,
  ) => () => void;
  /** Watches through reconnects. The returned function interrupts only this watch. */
  readonly watchOperation: (
    id: OperationId,
    onUpdate: (operation: DurableOperation) => void,
    onError?: (error: unknown) => void,
  ) => () => void;
  /** Runs an Effect-owned periodic fiber. It does not use a JavaScript timer handle. */
  readonly repeat: (intervalMs: number, task: () => void) => () => void;
  /** Interrupts all calls, reconnect work, watches, schedules, streams, and the owned socket. */
  readonly dispose: () => Promise<void>;
}

export function makeWorkClientRuntime(options: WorkClientRuntimeOptions): WorkClientRuntime {
  const clientId = options.clientId ?? ClientId.make(randomUUID());
  const managed = ManagedRuntime.make(
    workRpcClientLayer({
      socketPath: options.socketPath,
      clientId,
      ...(options.reconnectDelayMs === undefined
        ? {}
        : { reconnectDelayMs: options.reconnectDelayMs }),
      ...(options.onTransientError === undefined
        ? {}
        : {
            onTransientError: (error: unknown) =>
              Effect.sync(() => options.onTransientError?.(error)),
          }),
    }),
  );
  const activeFibers = new Set<() => Promise<unknown>>();
  const withClient = <A, E>(use: (client: WorkRpcClient) => Effect.Effect<A, E>): Promise<A> => {
    const fiber = managed.runFork(Effect.flatMap(WorkRpcClient, use));
    const interrupt = () => Effect.runPromise(Fiber.interrupt(fiber));
    activeFibers.add(interrupt);
    fiber.addObserver(() => activeFibers.delete(interrupt));
    return Effect.runPromise(Fiber.join(fiber));
  };
  const runObserved = (
    effect: Effect.Effect<void, unknown, WorkRpcClient>,
    onError?: (error: unknown) => void,
  ) => {
    const fiber = managed.runFork(effect);
    const interrupt = () => Effect.runPromise(Fiber.interrupt(fiber));
    activeFibers.add(interrupt);
    fiber.addObserver((exit) => {
      activeFibers.delete(interrupt);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        onError?.(Cause.squash(exit.cause));
      }
    });
    return () => {
      void interrupt();
    };
  };
  const subscribeState: WorkClientRuntime["subscribeState"] = (onItem, onError, capacity) =>
    runObserved(
      Effect.flatMap(WorkRpcClient, (client) =>
        client
          .subscribeState(capacity)
          .pipe(Stream.runForEach((item) => Effect.sync(() => onItem(item)))),
      ),
      onError,
    );
  const watchOperation: WorkClientRuntime["watchOperation"] = (id, onUpdate, onError) =>
    runObserved(
      Effect.flatMap(WorkRpcClient, (client) =>
        client.awaitOperation(id).pipe(
          Effect.tap((operation) => Effect.sync(() => onUpdate(operation))),
          Effect.asVoid,
        ),
      ),
      onError,
    );
  const repeat: WorkClientRuntime["repeat"] = (intervalMs, task) =>
    runObserved(Effect.forever(Effect.sleep(intervalMs).pipe(Effect.andThen(Effect.sync(task)))));
  const dispose = async (): Promise<void> => {
    await Promise.all([...activeFibers].map((interrupt) => interrupt()));
    activeFibers.clear();
    await managed.dispose();
  };

  return {
    clientId,
    compatibility: () => withClient((client) => client.compatibility),
    snapshot: () => withClient((client) => client.snapshot),
    startOperation: (request) => withClient((client) => client.startOperation(request)),
    getOperation: (id) => withClient((client) => client.getOperation(id)),
    awaitOperation: (id) => withClient((client) => client.awaitOperation(id)),
    startAndAwait: (request) => withClient((client) => client.startAndAwait(request)),
    requestOperationCancellation: (id, confirmationLifetimeMs) =>
      withClient((client) => client.requestOperationCancellation(id, confirmationLifetimeMs)),
    confirmOperation: (id, confirmation) =>
      withClient((client) => client.confirmOperation(id, confirmation)),
    rejectOperation: (id) => withClient((client) => client.rejectOperation(id)),
    atomicCommand: (command, requestId) =>
      withClient((client) => client.atomicCommand(command, requestId)),
    mainAgentCall: (request) => withClient((client) => client.mainAgentCall(request)),
    ephemeralAction: (action, topicId) =>
      withClient((client) => client.ephemeralAction(action, topicId)),
    watchOperation,
    repeat,
    subscribeState,
    dispose,
  };
}
