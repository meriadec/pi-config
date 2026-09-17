import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import {
  RpcFailure,
  type PrivateLocalCapability,
  type PublicWorkFailure,
} from "../../domain/index.ts";
import type { TopicCommands } from "../../application/command/index.ts";
import type {
  OperationEngine,
  OperationHandle,
  OperationStart,
} from "../../application/operation/index.ts";
import type { WorkStateProjection } from "../../application/state/index.ts";
import { WORK_RPC_MAX_FRAME_BYTES, WorkRpcGroup, type Compatibility } from "./protocol.ts";

export interface WorkRpcApplication {
  readonly compatibility: Effect.Effect<Compatibility, PublicWorkFailure>;
  readonly state: WorkStateProjection;
  readonly operations: Omit<OperationEngine, "start"> & {
    readonly start: (request: OperationStart) => Effect.Effect<OperationHandle, PublicWorkFailure>;
  };
  readonly commands: TopicCommands;
  /** A deep Main Agent boundary. The RPC adapter does not dispatch actions itself. */
  readonly mainAgentCall: (request: unknown) => Effect.Effect<unknown, PublicWorkFailure>;
  /** A deep Ephemeral Action boundary. Work ends when the request scope ends. */
  readonly ephemeralAction: (request: {
    readonly action:
      | "refresh"
      | "refresh-local"
      | "refresh-integration"
      | "refresh-pull-requests"
      | "rearrange"
      | "rebase"
      | "workspace"
      | "terminal"
      | "pull-request";
    readonly topicId?: import("../../domain/index.ts").TopicId | undefined;
  }) => Effect.Effect<unknown, PublicWorkFailure>;
}

export interface WorkRpcServerOptions {
  readonly socketPath: string;
  readonly application: WorkRpcApplication;
  readonly reportDefect?: (
    correlationId: string,
    cause: Cause.Cause<unknown>,
  ) => Effect.Effect<void>;
}

/**
 * Serves one generated RPC group. Effect RPC owns request correlation, cancellation, stream
 * lifetimes, and per-client write queues; the application owns Durable Operation fibers.
 */
export function workRpcServerLayer(options: WorkRpcServerOptions) {
  const app = options.application;
  const protect = <A>(correlationId: string, effect: Effect.Effect<A, PublicWorkFailure>) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        const expected = Option.getOrUndefined(Cause.findErrorOption(cause));
        if (expected !== undefined) return Effect.fail(expected);
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        const report = options.reportDefect?.(correlationId, cause) ?? Effect.void;
        return report.pipe(
          Effect.andThen(
            Effect.fail(
              new RpcFailure({
                reason: "internal",
                message: "The request failed because of an internal error.",
                details: { correlationId },
                internalCause: cause,
              }),
            ),
          ),
        );
      }),
    );

  const handlers = WorkRpcGroup.toLayer({
    Compatibility: (_request) => protect("compatibility", app.compatibility),
    Snapshot: (_request) => protect("snapshot", app.state.snapshot),
    SubscribeState: ({ capacity }) =>
      Stream.unwrap(
        app.state
          .subscribe(capacity)
          .pipe(
            Effect.map((subscription) =>
              subscription.stream.pipe(Stream.ensuring(subscription.close)),
            ),
          ),
      ),
    StartOperation: (request) =>
      protect(
        `operation-start:${request.requestId}`,
        app.operations.start(request as OperationStart).pipe(Effect.map(encodeHandle)),
      ),
    GetOperation: ({ id }) => protect(`operation-get:${id}`, app.operations.get(id)),
    WatchOperation: ({ id }) =>
      Stream.unwrap(
        protect(`operation-watch:${id}`, app.operations.watch(id)).pipe(
          Effect.map((watch) => watch.stream.pipe(Stream.ensuring(watch.close))),
        ),
      ),
    CancelOperation: ({ id, confirmationLifetimeMs }) =>
      protect(
        `operation-cancel:${id}`,
        app.operations
          .requestCancellation(id, confirmationLifetimeMs)
          .pipe(Effect.map((confirmation) => ({ confirmation: Redacted.value(confirmation) }))),
      ),
    ConfirmOperation: ({ id, confirmation }) =>
      protect(`operation-confirm:${id}`, app.operations.confirm(id, capability(confirmation))),
    RejectOperation: ({ id }) => protect(`operation-reject:${id}`, app.operations.reject(id)),
    AtomicCommand: (request) =>
      protect(
        `atomic-command:${request.requestId}`,
        request.command._tag === "ResetIntegrationBranch"
          ? app.commands.resetIntegrationBranch({
              clientId: request.clientId,
              requestId: request.requestId,
              repository: request.command.repository,
              expectedRevision: request.command.expectedRevision,
            })
          : app.commands.execute({
              clientId: request.clientId,
              requestId: request.requestId,
              command:
                request.command._tag === "MoveInChain" && request.command.confirmed === undefined
                  ? {
                      _tag: request.command._tag,
                      topicId: request.command.topicId,
                      target: request.command.target,
                    }
                  : (request.command as import("../../application/command/index.ts").TopicCommand),
            }),
      ),
    MainAgentCall: (request) => protect("main-agent-call", app.mainAgentCall(request)),
    EphemeralAction: (request) =>
      protect(
        "ephemeral-action",
        app
          .ephemeralAction(request)
          .pipe(Effect.map((value) => value ?? { status: "completed" as const })),
      ),
  });
  const serialization = RpcSerialization.layerNdjsonWith({
    maxBufferSize: WORK_RPC_MAX_FRAME_BYTES,
  });

  return RpcServer.layer(WorkRpcGroup, {
    // Defects are converted at each application boundary. Keep a transport defect local too.
    disableFatalDefects: true,
  }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(serialization),
    Layer.provide(BunSocketServer.layer({ path: options.socketPath })),
  );
}

function capability(value: string): PrivateLocalCapability {
  return Redacted.make(value, { label: "Private local capability" }) as PrivateLocalCapability;
}

function encodeHandle(handle: OperationHandle): {
  readonly id: OperationHandle["id"];
  readonly state: OperationHandle["state"];
  readonly confirmation?: string;
  readonly confirmationText?: string;
} {
  return {
    id: handle.id,
    state: handle.state,
    ...(handle.confirmation === undefined
      ? {}
      : { confirmation: Redacted.value(handle.confirmation) }),
    ...(handle.confirmationText === undefined ? {} : { confirmationText: handle.confirmationText }),
  };
}
