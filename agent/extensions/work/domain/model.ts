import * as Schema from "effect/Schema";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/;
const fullCommitPattern = /^[0-9a-f]{40}$/;
const timestampPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

function boundedString(maximum: number) {
  return Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));
}

function brandedUuid<const Brand extends string>(brand: Brand) {
  return Schema.String.check(
    Schema.isPattern(uuidPattern, { expected: `a UUID for ${brand}` }),
  ).pipe(Schema.brand(brand));
}

export const TopicId = brandedUuid("Work/TopicId");
export type TopicId = typeof TopicId.Type;

export const OperationId = brandedUuid("Work/OperationId");
export type OperationId = typeof OperationId.Type;

export const ClientId = brandedUuid("Work/ClientId");
export type ClientId = typeof ClientId.Type;

export const RequestId = brandedUuid("Work/RequestId");
export type RequestId = typeof RequestId.Type;

/** True only for a Git check-ref-format compatible Branch accepted by Work. */
export function isValidBranch(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value === "@" ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("[") ||
    /[~^:?*\\]/.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || code === 127;
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export const Branch = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isValidBranch, { expected: "a valid Git Branch" })),
  Schema.brand("Work/Branch"),
);
export type Branch = typeof Branch.Type;

export const Repository = Schema.String.check(
  Schema.isMaxLength(140),
  Schema.isPattern(repositoryPattern, { expected: "a GitHub repository in owner/repo form" }),
  Schema.makeFilter((value) => !value.endsWith("/.") && !value.endsWith("/.."), {
    expected: "a GitHub repository in owner/repo form",
  }),
).pipe(Schema.brand("Work/Repository"));
export type Repository = typeof Repository.Type;

export const FullCommitSha = Schema.String.check(
  Schema.isPattern(fullCommitPattern, { expected: "a full lowercase Git commit SHA" }),
).pipe(Schema.brand("Work/FullCommitSha"));
export type FullCommitSha = typeof FullCommitSha.Type;

export const AbsolutePath = Schema.String.check(
  Schema.isMaxLength(4_096),
  Schema.makeFilter((value) => value.startsWith("/") && !value.includes("\0"), {
    expected: "an absolute path",
  }),
).pipe(Schema.brand("Work/AbsolutePath"));
export type AbsolutePath = typeof AbsolutePath.Type;

const positiveVersion = Schema.Int.check(Schema.isGreaterThan(0));
export const ProtocolVersion = positiveVersion.pipe(Schema.brand("Work/ProtocolVersion"));
export type ProtocolVersion = typeof ProtocolVersion.Type;
export const StorageSchemaVersion = positiveVersion.pipe(Schema.brand("Work/StorageSchemaVersion"));
export type StorageSchemaVersion = typeof StorageSchemaVersion.Type;

/** Current branded versions for the new Work control-plane boundaries. */
export const WORK_PROTOCOL_VERSION = ProtocolVersion.make(2);
export const WORK_STORAGE_SCHEMA_VERSION = StorageSchemaVersion.make(2);

/** A bearer value. Its normal rendering and inspection do not expose the value. */
export const PrivateLocalCapability = Schema.RedactedFromValue(boundedString(1_024), {
  label: "Private local capability",
  disallowEncode: true,
});
export type PrivateLocalCapability = typeof PrivateLocalCapability.Type;

const MAX_OPERATION_JSON_BYTES = 16_384;
const JsonPayload = Schema.Unknown.check(
  Schema.makeFilter(
    (value) => {
      try {
        const encoded = JSON.stringify(value);
        return encoded !== undefined && encoded.length <= MAX_OPERATION_JSON_BYTES;
      } catch {
        return false;
      }
    },
    { expected: `JSON data of at most ${MAX_OPERATION_JSON_BYTES} bytes` },
  ),
);

/** Versioned and bounded input accepted by a Durable Operation. */
export const DurableOperationInput = Schema.Struct({
  version: Schema.Literal(1),
  kind: boundedString(100),
  value: JsonPayload,
});
export type DurableOperationInput = typeof DurableOperationInput.Type;

/** Versioned and bounded semantic terminal result. It cannot contain process output. */
export const DurableOperationResult = Schema.Struct({
  version: Schema.Literal(1),
  status: Schema.Literals(["succeeded", "failed", "cancelled"]),
  value: JsonPayload,
});
export type DurableOperationResult = typeof DurableOperationResult.Type;

export const DurableOperationState = Schema.Literals([
  "accepted",
  "awaiting-confirmation",
  "running",
  "setup-interrupted",
  "succeeded",
  "failed",
  "cancelled",
]);
export type DurableOperationState = typeof DurableOperationState.Type;

export const SetupStepState = Schema.Literals(["running", "completed", "interrupted"]);
export type SetupStepState = typeof SetupStepState.Type;

export const SetupState = Schema.Literals([
  "provisioning",
  "ready",
  "setup-failed",
  "setup-interrupted",
]);
export type SetupState = typeof SetupState.Type;

export const TopicSetup = Schema.Struct({
  state: SetupState,
  repositoryAvailable: Schema.Boolean,
  worktreeCreated: Schema.Boolean,
  setupCommandsRun: Schema.Boolean,
  completedCommandCount: Schema.Natural,
  reason: Schema.optional(boundedString(200)),
});
export type TopicSetup = typeof TopicSetup.Type;

/** The Main Agent identity that survives disconnects and daemon restarts. */
export const MainAgentDurableIdentity = Schema.Struct({
  sessionId: boundedString(200),
  sessionFile: Schema.NullOr(AbsolutePath),
});
export type MainAgentDurableIdentity = typeof MainAgentDurableIdentity.Type;

export const IntegrationTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("integration-branch") }),
  Schema.Struct({ kind: Schema.Literal("topic"), topicId: TopicId }),
]);
export type IntegrationTarget = typeof IntegrationTarget.Type;

export const StartPoint = Schema.Struct({
  commit: FullCommitSha,
  sourceCheckout: AbsolutePath,
});
export type StartPoint = typeof StartPoint.Type;

const SetupCommand = boundedString(4_000);
export const RepositoryRecipe = Schema.Struct({
  setupCommands: Schema.Array(SetupCommand).check(Schema.isMaxLength(50)),
  basePath: Schema.optional(AbsolutePath),
  integrationBranch: Schema.optional(Branch),
});
export type RepositoryRecipe = typeof RepositoryRecipe.Type;

export const ActionId = Schema.Literals([
  "repository.clone",
  "topic.create-worktree",
  "topic.run-setup",
  "terminal.open",
  "agent.open",
  "agent.reset",
  "topic.delete",
]);
export type ActionId = typeof ActionId.Type;

export const ActionPolicy = Schema.Literals(["allow", "ask", "deny"]);
export type ActionPolicy = typeof ActionPolicy.Type;

export const Policy = Schema.Struct({
  action: ActionId,
  decision: ActionPolicy,
  scope: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("global") }),
    Schema.Struct({ kind: Schema.Literal("repository"), repository: Repository }),
    Schema.Struct({ kind: Schema.Literal("topic"), topicId: TopicId }),
  ]),
});
export type Policy = typeof Policy.Type;

/** Durable identity only. Live pull request data is an observation. */
export const PullRequestIdentity = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type PullRequestIdentity = typeof PullRequestIdentity.Type;

const Timestamp = Schema.String.check(
  Schema.isPattern(timestampPattern, { expected: "an ISO-8601 UTC timestamp" }),
);

/** Authoritative state stored for one Topic. It excludes cache-like observations. */
export const DurableTopic = Schema.Struct({
  id: TopicId,
  name: boundedString(200),
  note: Schema.optional(boundedString(200)),
  branch: Branch,
  repository: Repository,
  setup: TopicSetup,
  worktreePath: Schema.NullOr(AbsolutePath),
  mainAgent: MainAgentDurableIdentity,
  partition: Schema.Int,
  parentTopicId: Schema.optional(TopicId),
  originCommit: Schema.optional(FullCommitSha),
  integrationTarget: Schema.optional(IntegrationTarget),
  chainState: Schema.optional(Schema.Literals(["active", "pending"])),
  pullRequest: Schema.optional(PullRequestIdentity),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type DurableTopic = typeof DurableTopic.Type;

/** Canonical Topic name. The durable qualifier documents its persistence role. */
export const Topic = DurableTopic;
export type Topic = DurableTopic;

export const IntegrationStatus = Schema.Literals(["current", "behind", "conflict", "unknown"]);
export const GitOperationState = Schema.Literals([
  "none",
  "rebase",
  "merge",
  "cherry-pick",
  "revert",
  "unknown",
]);
export const MainAgentActivity = Schema.Literals([
  "starting",
  "thinking",
  "thinking-sub",
  "idle",
  "tracking-pr",
  "waiting-for-human",
  "stopped",
  "failed",
]);
export type MainAgentActivity = typeof MainAgentActivity.Type;

/** Rebuilt observations. This record is not part of the durable Topic codec. */
export const ObservedTopicState = Schema.Struct({
  topicId: TopicId,
  integrationStatus: IntegrationStatus,
  gitOperationState: GitOperationState,
  worktreePresent: Schema.Boolean,
  /** Null when cleanliness could not be observed. */
  worktreeClean: Schema.NullOr(Schema.Boolean),
  orphan: Schema.Boolean,
  mainAgentActivity: Schema.optional(MainAgentActivity),
});
export type ObservedTopicState = typeof ObservedTopicState.Type;

export const PullRequestObservation = Schema.Struct({
  identity: PullRequestIdentity,
  url: boundedString(2_048),
  state: Schema.Literals(["open", "merged", "closed"]),
  draft: Schema.Boolean,
  ci: Schema.Literals(["none", "pending", "passing", "failing"]),
  reviewPending: Schema.Boolean,
  copilotReviewed: Schema.Boolean,
  changesRequested: Schema.Boolean,
  approved: Schema.Boolean,
  unresolvedThreads: Schema.Natural,
});
export type PullRequestObservation = typeof PullRequestObservation.Type;

/** Decoders used once at untrusted boundaries. Callers then pass branded values. */
export const decodeTopicId = Schema.decodeUnknownSync(TopicId);
export const decodeOperationId = Schema.decodeUnknownSync(OperationId);
export const decodeClientId = Schema.decodeUnknownSync(ClientId);
export const decodeRequestId = Schema.decodeUnknownSync(RequestId);
export const decodeBranch = Schema.decodeUnknownSync(Branch);
export const decodeRepository = Schema.decodeUnknownSync(Repository);
export const decodeFullCommitSha = Schema.decodeUnknownSync(FullCommitSha);
export const decodeAbsolutePath = Schema.decodeUnknownSync(AbsolutePath);
