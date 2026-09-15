import * as Schema from "effect/Schema";
import {
  Branch,
  DurableOperationInput,
  DurableOperationResult,
  DurableOperationState,
  DurableTopic,
  OperationId,
  PullRequestObservation,
  Repository,
  TopicId,
  ObservedTopicState,
} from "../../domain/index.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String.check(Schema.isMaxLength(100), Schema.isNonEmpty());
const BoundedMessage = Schema.String.check(Schema.isMaxLength(1_000), Schema.isNonEmpty());

/** Identifies one daemon run. Revisions only have meaning with this identity. */
export const WorkDaemonIdentity = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200), Schema.isNonEmpty()),
  startedAt: Timestamp,
});
export type WorkDaemonIdentity = typeof WorkDaemonIdentity.Type;

/** Freshness is separate from an observation value so stale data can stay visible during refresh. */
export const ObservationFreshness = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Unknown") }),
  Schema.Struct({ _tag: Schema.Literal("Refreshing"), startedAt: Timestamp }),
  Schema.Struct({ _tag: Schema.Literal("Fresh"), observedAt: Timestamp }),
  Schema.Struct({ _tag: Schema.Literal("Failed"), failedAt: Timestamp, message: BoundedMessage }),
]);
export type ObservationFreshness = typeof ObservationFreshness.Type;

export const RevisionedProjectedTopic = Schema.Struct({
  topic: DurableTopic,
  rowRevision: Revision,
});
export type RevisionedProjectedTopic = typeof RevisionedProjectedTopic.Type;

export const ProjectedRepositoryState = Schema.Struct({
  repository: Repository,
  inferredIntegrationBranch: Branch,
  rowRevision: Revision,
  updatedAt: Timestamp,
});
export type ProjectedRepositoryState = typeof ProjectedRepositoryState.Type;

/** Durable Operation fields needed by state consumers. Raw capabilities and checkpoints are absent. */
export const ProjectedOperation = Schema.Struct({
  id: OperationId,
  topicId: Schema.optional(TopicId),
  state: DurableOperationState,
  phase: Schema.String.check(Schema.isMaxLength(200), Schema.isNonEmpty()),
  input: DurableOperationInput,
  result: Schema.optional(DurableOperationResult),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  terminalAt: Schema.optional(Timestamp),
  rowRevision: Revision,
});
export type ProjectedOperation = typeof ProjectedOperation.Type;

export const ProjectedTopicObservation = Schema.Struct({
  topicId: TopicId,
  freshness: ObservationFreshness,
  value: Schema.optional(ObservedTopicState),
});
export type ProjectedTopicObservation = typeof ProjectedTopicObservation.Type;

export const ProjectedPullRequestObservation = Schema.Struct({
  topicId: TopicId,
  freshness: ObservationFreshness,
  value: Schema.optional(PullRequestObservation),
});
export type ProjectedPullRequestObservation = typeof ProjectedPullRequestObservation.Type;

export const ObservationDiagnostic = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(100), Schema.isNonEmpty()),
  message: BoundedMessage,
  topicId: Schema.optional(TopicId),
  observedAt: Timestamp,
});
export type ObservationDiagnostic = typeof ObservationDiagnostic.Type;

export const EphemeralAction = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(200), Schema.isNonEmpty()),
  kind: Schema.String.check(Schema.isMaxLength(100), Schema.isNonEmpty()),
  topicId: Schema.optional(TopicId),
  startedAt: Timestamp,
});
export type EphemeralAction = typeof EphemeralAction.Type;

export const WorkDurableProjection = Schema.Struct({
  topics: Schema.Array(RevisionedProjectedTopic),
  repositoryStates: Schema.Array(ProjectedRepositoryState),
  operations: Schema.Array(ProjectedOperation),
});
export type WorkDurableProjection = typeof WorkDurableProjection.Type;

export const WorkObservedProjection = Schema.Struct({
  topics: Schema.Array(ProjectedTopicObservation),
  pullRequests: Schema.Array(ProjectedPullRequestObservation),
  diagnostics: Schema.Array(ObservationDiagnostic),
  activeActions: Schema.Array(EphemeralAction),
});
export type WorkObservedProjection = typeof WorkObservedProjection.Type;

/** Complete reconnect unit for all durable and cache-like Work state. */
export const WorkSnapshot = Schema.Struct({
  daemon: WorkDaemonIdentity,
  revision: Revision,
  durable: WorkDurableProjection,
  observed: WorkObservedProjection,
});
export type WorkSnapshot = typeof WorkSnapshot.Type;

export const emptyDurableProjection = (): WorkDurableProjection => ({
  topics: [],
  repositoryStates: [],
  operations: [],
});

export const emptyObservedProjection = (): WorkObservedProjection => ({
  topics: [],
  pullRequests: [],
  diagnostics: [],
  activeActions: [],
});
