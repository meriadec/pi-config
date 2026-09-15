import { randomUUID } from "node:crypto";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Stream from "effect/Stream";
import {
  ClientId,
  RequestId,
  RpcFailure,
  type DurableOperationInput,
  type DurableOperationResult,
  type OperationId,
  type PublicWorkFailure,
  type TopicId,
} from "../../domain/index.ts";
import {
  advanceWorkStreamCursor,
  type WorkSnapshot,
  type WorkStreamCursor,
  type WorkStreamItem,
} from "../../application/state/index.ts";
import {
  WORK_RPC_DEFAULT_STREAM_CAPACITY,
  WORK_RPC_MAX_FRAME_BYTES,
  WorkRpcGroup,
  type Compatibility,
  type DurableOperation,
  type OperationHandle,
  type TopicCommand,
} from "./protocol.ts";

export type WorkRpcClientFailure = PublicWorkFailure | RpcClientError;

export interface StartOperationRequest {
  readonly requestId?: RequestId;
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

export type MainAgentCallRequest =
  | { readonly action: "open" | "reset"; readonly topicId: TopicId }
  | {
      readonly action: "register" | "adopt";
      readonly connectionId: string;
      readonly topicId: TopicId;
      readonly sessionId: string;
      readonly sessionFile: import("../../domain/index.ts").AbsolutePath;
      readonly capability: string;
    }
  | { readonly action: "heartbeat" | "disconnected"; readonly connectionId: string }
  | {
      readonly action: "report";
      readonly connectionId: string;
      readonly activity: import("../../domain/index.ts").MainAgentActivity;
    };

/** A generated Effect RPC client with Work-specific operation and reconnect policy. */
export interface WorkRpcClient {
  /** Stable for all command retries made through this dashboard or adapter runtime. */
  readonly clientId: ClientId;
  readonly compatibility: Effect.Effect<Compatibility, WorkRpcClientFailure>;
  readonly snapshot: Effect.Effect<WorkSnapshot, WorkRpcClientFailure>;
  readonly subscribeState: (
    capacity?: number,
  ) => Stream.Stream<WorkStreamItem, WorkRpcClientFailure>;
  readonly startOperation: (
    request: StartOperationRequest,
  ) => Effect.Effect<OperationHandle, WorkRpcClientFailure>;
  readonly getOperation: (id: OperationId) => Effect.Effect<DurableOperation, WorkRpcClientFailure>;
  readonly watchOperation: (
    id: OperationId,
  ) => Stream.Stream<DurableOperation, WorkRpcClientFailure>;
  readonly awaitOperation: (
    id: OperationId,
  ) => Effect.Effect<DurableOperation, WorkRpcClientFailure>;
  readonly startAndAwait: (
    request: StartOperationRequest,
  ) => Effect.Effect<DurableOperation, WorkRpcClientFailure>;
  readonly requestOperationCancellation: (
    id: OperationId,
    confirmationLifetimeMs: number,
  ) => Effect.Effect<{ readonly confirmation: string }, WorkRpcClientFailure>;
  readonly confirmOperation: (
    id: OperationId,
    confirmation: string,
  ) => Effect.Effect<DurableOperation, WorkRpcClientFailure>;
  readonly rejectOperation: (
    id: OperationId,
  ) => Effect.Effect<DurableOperation, WorkRpcClientFailure>;
  readonly atomicCommand: (
    command: TopicCommand,
    requestId?: RequestId,
  ) => Effect.Effect<DurableOperationResult, WorkRpcClientFailure>;
  readonly mainAgentCall: (
    request: MainAgentCallRequest,
  ) => Effect.Effect<unknown, WorkRpcClientFailure>;
  readonly ephemeralAction: (
    action: "refresh" | "refresh-local" | "refresh-pull-requests" | "rebase",
    topicId?: TopicId,
  ) => Effect.Effect<void, WorkRpcClientFailure>;
}

export const WorkRpcClient = Context.Service<WorkRpcClient>("Work/WorkRpcClient");

export interface WorkRpcClientLayerOptions {
  readonly socketPath: string;
  readonly clientId?: ClientId;
  readonly reconnectDelayMs?: number;
  readonly onTransientError?: (error: RpcClientError) => Effect.Effect<void>;
}

/**
 * Owns the Unix socket and all generated RPC request, stream, and correlation state in one Scope.
 * The socket protocol retries transient opens. A state stream also resubscribes after a transport
 * loss, daemon identity change, revision gap, or explicit ResyncRequired marker.
 */
export function workRpcClientLayer(
  options: WorkRpcClientLayerOptions,
): Layer.Layer<WorkRpcClient, RpcFailure> {
  const serialization = RpcSerialization.layerNdjsonWith({
    maxBufferSize: WORK_RPC_MAX_FRAME_BYTES,
  });
  const protocol = RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
    ...(options.onTransientError === undefined
      ? {}
      : { onTransientError: options.onTransientError }),
  }).pipe(
    Layer.provide(serialization),
    Layer.provide(BunSocket.layerNet({ path: options.socketPath })),
  );

  return Layer.effect(
    WorkRpcClient,
    Effect.gen(function* () {
      const context = yield* Layer.build(protocol);
      const rpc = yield* RpcClient.make(WorkRpcGroup).pipe(Effect.provide(context));
      const clientId = options.clientId ?? ClientId.make(randomUUID());
      const reconnectDelayMs = options.reconnectDelayMs ?? 100;
      const requestId = () => RequestId.make(randomUUID());

      const subscribeState = (
        capacity = WORK_RPC_DEFAULT_STREAM_CAPACITY,
      ): Stream.Stream<WorkStreamItem, WorkRpcClientFailure> => {
        if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000) {
          return Stream.fail(
            new RpcFailure({
              reason: "invalid-request",
              message: "Work state capacity must be an integer from 1 through 10000.",
              internalCause: undefined,
            }),
          );
        }
        const connect = (): Stream.Stream<WorkStreamItem, WorkRpcClientFailure> =>
          Stream.suspend(() => {
            let cursor: WorkStreamCursor = { _tag: "AwaitingSnapshot" };
            return rpc.SubscribeState({ capacity }).pipe(
              Stream.mapEffect((item) =>
                Effect.suspend(() => {
                  const applicationItem = item as WorkStreamItem;
                  const next = advanceWorkStreamCursor(cursor, applicationItem);
                  if (next._tag === "Resubscribe") {
                    return Effect.fail(
                      new RpcFailure({
                        reason: "resync-required",
                        message: "The Work state stream must be synchronized again.",
                        internalCause: undefined,
                      }),
                    );
                  }
                  cursor = next;
                  return Effect.succeed(applicationItem);
                }),
              ),
              Stream.catch(() =>
                Stream.fromEffect(Effect.sleep(reconnectDelayMs)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.suspend(connect)),
                ),
              ),
            );
          });
        return connect();
      };

      const startOperation: WorkRpcClient["startOperation"] = (request) =>
        rpc.StartOperation({
          clientId,
          requestId: request.requestId ?? requestId(),
          fingerprint: request.fingerprint,
          input: request.input,
          ...(request.topicId === undefined ? {} : { topicId: request.topicId }),
          ...(request.phase === undefined ? {} : { phase: request.phase }),
          ...(request.confirmation === undefined ? {} : { confirmation: request.confirmation }),
        });
      const getOperation: WorkRpcClient["getOperation"] = (id) => rpc.GetOperation({ id });
      const watchOperation: WorkRpcClient["watchOperation"] = (id) => rpc.WatchOperation({ id });
      const awaitOperation: WorkRpcClient["awaitOperation"] = (id) => {
        const wait = (): Effect.Effect<DurableOperation, WorkRpcClientFailure> =>
          getOperation(id).pipe(
            Effect.flatMap((initial) => {
              if (isTerminal(initial)) return Effect.succeed(initial);
              return watchOperation(id).pipe(
                Stream.filter(isTerminal),
                Stream.runHead,
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.sleep(reconnectDelayMs).pipe(Effect.andThen(wait())),
                    onSome: Effect.succeed,
                  }),
                ),
                Effect.catch(() => Effect.sleep(reconnectDelayMs).pipe(Effect.andThen(wait()))),
              );
            }),
          );
        return Effect.suspend(wait);
      };

      return {
        clientId,
        compatibility: rpc.Compatibility(),
        snapshot: rpc.Snapshot(),
        subscribeState,
        startOperation,
        getOperation,
        watchOperation,
        awaitOperation,
        startAndAwait: (request: StartOperationRequest) =>
          startOperation(request).pipe(Effect.flatMap((handle) => awaitOperation(handle.id))),
        requestOperationCancellation: (id: OperationId, confirmationLifetimeMs: number) =>
          rpc.CancelOperation({ id, confirmationLifetimeMs }),
        confirmOperation: (id: OperationId, confirmation: string) =>
          rpc.ConfirmOperation({ id, confirmation }),
        rejectOperation: (id: OperationId) => rpc.RejectOperation({ id }),
        atomicCommand: (command: TopicCommand, id: RequestId = requestId()) =>
          rpc.AtomicCommand({ clientId, requestId: id, command }),
        mainAgentCall: (request: MainAgentCallRequest) => rpc.MainAgentCall(request),
        ephemeralAction: (
          action: "refresh" | "refresh-local" | "refresh-pull-requests" | "rebase",
          topicId?: TopicId,
        ) => rpc.EphemeralAction({ action, ...(topicId === undefined ? {} : { topicId }) }),
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new RpcFailure({
            reason: "unavailable",
            message: "The Work daemon socket is unavailable.",
            internalCause: cause,
          }),
      ),
    ),
  );
}

function isTerminal(operation: DurableOperation): boolean {
  return (
    operation.state === "succeeded" ||
    operation.state === "failed" ||
    operation.state === "cancelled"
  );
}
