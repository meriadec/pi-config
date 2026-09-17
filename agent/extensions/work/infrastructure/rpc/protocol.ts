import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import {
  AbsolutePath,
  ClientId,
  DurableOperationInput,
  DurableOperationResult,
  DurableOperationState,
  MainAgentActivity,
  OperationId,
  PublicWorkFailure,
  RequestId,
  Repository,
  TopicId,
  WORK_PROTOCOL_VERSION,
  WORK_STORAGE_SCHEMA_VERSION,
} from "../../domain/index.ts";
import {
  ObservationDiagnostic,
  ProjectedOperation,
  ProjectedPullRequestObservation,
  ProjectedRepositoryState,
  ProjectedTopicObservation,
  RevisionedProjectedTopic,
  WorkSnapshot,
} from "../../application/state/index.ts";

/** Both the decoder buffer and every application frame use this bound. */
export const WORK_RPC_MAX_FRAME_BYTES = 1024 * 1024;
export const WORK_RPC_DEFAULT_STREAM_CAPACITY = 64;

const NonEmpty = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const Capability = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_024));
const ConfirmationText = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(1_000));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const boundedFrame = <S extends Schema.Top>(schema: S): S =>
  schema.check(
    Schema.makeFilter((value) => encodedSize(value) <= WORK_RPC_MAX_FRAME_BYTES, {
      expected: `an encoded RPC frame of at most ${WORK_RPC_MAX_FRAME_BYTES} bytes`,
    }),
  ) as S;

export const CompatibilityState = Schema.Literals(["starting", "ready", "stopping"]);
export const Compatibility = boundedFrame(
  Schema.Struct({
    applicationProtocol: Schema.Literal(WORK_PROTOCOL_VERSION),
    storageSchema: Schema.Literal(WORK_STORAGE_SCHEMA_VERSION),
    buildId: NonEmpty,
    startId: NonEmpty,
    state: CompatibilityState,
  }),
);
export type Compatibility = typeof Compatibility.Type;

export const DurableOperation = boundedFrame(
  Schema.Struct({
    id: OperationId,
    clientId: ClientId,
    requestId: RequestId,
    topicId: Schema.optional(TopicId),
    state: DurableOperationState,
    phase: NonEmpty,
    input: DurableOperationInput,
    result: Schema.optional(DurableOperationResult),
    createdAt: NonEmpty,
    updatedAt: NonEmpty,
    terminalAt: Schema.optional(NonEmpty),
    revision: Revision,
  }),
);
export type DurableOperation = typeof DurableOperation.Type;

export const OperationHandle = Schema.Struct({
  id: OperationId,
  state: DurableOperationState,
  confirmation: Schema.optional(Capability),
  confirmationText: Schema.optional(ConfirmationText),
});
export type OperationHandle = typeof OperationHandle.Type;

export const TopicCommand = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Rename"), topicId: TopicId, name: NonEmpty }),
  Schema.Struct({
    _tag: Schema.Literal("SetNote"),
    topicId: TopicId,
    note: Schema.String.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("MovePartition"),
    topicId: TopicId,
    direction: Schema.Literals(["up", "down"]),
  }),
  Schema.Struct({ _tag: Schema.Literal("ChangeParent"), topicId: TopicId, parentTopicId: TopicId }),
  Schema.Struct({ _tag: Schema.Literal("RemoveParent"), topicId: TopicId }),
  Schema.Struct({
    _tag: Schema.Literal("MoveInChain"),
    topicId: TopicId,
    target: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("integration-branch") }),
      Schema.Struct({ kind: Schema.Literal("topic"), topicId: TopicId }),
    ]),
    confirmed: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ _tag: Schema.Literal("ResetIntegrationTarget"), topicId: TopicId }),
  Schema.Struct({ _tag: Schema.Literal("ActivatePendingChild"), topicId: TopicId }),
  Schema.Struct({ _tag: Schema.Literal("Delete"), topicId: TopicId }),
  Schema.Struct({
    _tag: Schema.Literal("ResetIntegrationBranch"),
    repository: Repository,
    expectedRevision: Revision,
  }),
]);
export type TopicCommand = typeof TopicCommand.Type;

export const MainAgentLease = Schema.Struct({
  topicId: TopicId,
  sessionId: NonEmpty,
  activity: MainAgentActivity,
  connected: Schema.Boolean,
  reason: Schema.optional(NonEmpty),
});

const ProjectionPatch = <S extends Schema.Top>(schema: S) =>
  Schema.Struct({
    upsert: Schema.optional(Schema.Array(schema)),
    remove: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(200)))),
  });

// The state module owns reduction. This schema is duplicated here only to keep the wire seam typed.
const WorkProjectionChange = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("DurableCommitted"),
    topics: Schema.optional(ProjectionPatch(RevisionedProjectedTopic)),
    repositoryStates: Schema.optional(ProjectionPatch(ProjectedRepositoryState)),
    operations: Schema.optional(ProjectionPatch(ProjectedOperation)),
  }),
  Schema.Struct({
    _tag: Schema.Literal("ObservedChanged"),
    topics: Schema.optional(ProjectionPatch(ProjectedTopicObservation)),
    pullRequests: Schema.optional(ProjectionPatch(ProjectedPullRequestObservation)),
    diagnostics: Schema.optional(Schema.Array(ObservationDiagnostic)),
    activeActions: Schema.optional(WorkSnapshot.fields.observed.fields.activeActions),
  }),
]);

export const WorkStreamItem = boundedFrame(
  Schema.Union([
    Schema.Struct({ _tag: Schema.Literal("Snapshot"), snapshot: WorkSnapshot }),
    Schema.Struct({
      _tag: Schema.Literal("Change"),
      daemonId: NonEmpty,
      revision: Revision,
      change: WorkProjectionChange,
    }),
    Schema.Struct({
      _tag: Schema.Literal("ResyncRequired"),
      daemonId: NonEmpty,
      expectedRevision: Revision,
      actualRevision: Revision,
    }),
  ]),
);

const error = PublicWorkFailure;
export const CompatibilityRpc = Rpc.make("Compatibility", { success: Compatibility, error });
export const SnapshotRpc = Rpc.make("Snapshot", { success: boundedFrame(WorkSnapshot), error });
export const SubscribeStateRpc = Rpc.make("SubscribeState", {
  payload: {
    capacity: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 }))),
  },
  success: WorkStreamItem,
  error,
  stream: true,
});
export const StartOperationRpc = Rpc.make("StartOperation", {
  payload: {
    clientId: ClientId,
    requestId: RequestId,
    fingerprint: NonEmpty,
    input: DurableOperationInput,
    topicId: Schema.optional(TopicId),
    phase: Schema.optional(NonEmpty),
    confirmation: Schema.optional(
      Schema.Struct({
        action: NonEmpty,
        lifetimeMs: Schema.Int.check(Schema.isGreaterThan(0)),
        durable: Schema.Boolean,
      }),
    ),
  },
  success: OperationHandle,
  error,
});
export const GetOperationRpc = Rpc.make("GetOperation", {
  payload: { id: OperationId },
  success: DurableOperation,
  error,
});
export const WatchOperationRpc = Rpc.make("WatchOperation", {
  payload: { id: OperationId },
  success: DurableOperation,
  error,
  stream: true,
});
export const CancelOperationRpc = Rpc.make("CancelOperation", {
  payload: { id: OperationId, confirmationLifetimeMs: Schema.Int.check(Schema.isGreaterThan(0)) },
  success: Schema.Struct({ confirmation: Capability }),
  error,
});
export const ConfirmOperationRpc = Rpc.make("ConfirmOperation", {
  payload: { id: OperationId, confirmation: Capability },
  success: DurableOperation,
  error,
});
export const RejectOperationRpc = Rpc.make("RejectOperation", {
  payload: { id: OperationId },
  success: DurableOperation,
  error,
});
export const AtomicCommandRpc = Rpc.make("AtomicCommand", {
  payload: { clientId: ClientId, requestId: RequestId, command: TopicCommand },
  success: DurableOperationResult,
  error,
});
export const MainAgentCallRpc = Rpc.make("MainAgentCall", {
  payload: Schema.Union([
    Schema.Struct({ action: Schema.Literal("open"), topicId: TopicId }),
    Schema.Struct({ action: Schema.Literal("reset"), topicId: TopicId }),
    Schema.Struct({
      action: Schema.Literal("register"),
      connectionId: NonEmpty,
      topicId: TopicId,
      sessionId: NonEmpty,
      sessionFile: AbsolutePath,
      capability: Capability,
    }),
    Schema.Struct({
      action: Schema.Literal("adopt"),
      connectionId: NonEmpty,
      topicId: TopicId,
      sessionId: NonEmpty,
      sessionFile: AbsolutePath,
      capability: Capability,
    }),
    Schema.Struct({ action: Schema.Literal("heartbeat"), connectionId: NonEmpty }),
    Schema.Struct({
      action: Schema.Literal("report"),
      connectionId: NonEmpty,
      activity: MainAgentActivity,
    }),
    Schema.Struct({ action: Schema.Literal("disconnected"), connectionId: NonEmpty }),
  ]),
  success: boundedFrame(Schema.Unknown),
  error,
});
export const EphemeralActionRpc = Rpc.make("EphemeralAction", {
  payload: {
    action: Schema.Literals([
      "refresh",
      "refresh-local",
      "refresh-integration",
      "refresh-pull-requests",
      "rearrange",
      "rebase",
      "workspace",
      "terminal",
      "pull-request",
    ]),
    topicId: Schema.optional(TopicId),
  },
  success: boundedFrame(Schema.Unknown),
  error,
});

/** One generated-client contract for the complete Work control plane. */
export const WorkRpcGroup = RpcGroup.make(
  CompatibilityRpc,
  SnapshotRpc,
  SubscribeStateRpc,
  StartOperationRpc,
  GetOperationRpc,
  WatchOperationRpc,
  CancelOperationRpc,
  ConfirmOperationRpc,
  RejectOperationRpc,
  AtomicCommandRpc,
  MainAgentCallRpc,
  EphemeralActionRpc,
);

function encodedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return WORK_RPC_MAX_FRAME_BYTES + 1;
  }
}
