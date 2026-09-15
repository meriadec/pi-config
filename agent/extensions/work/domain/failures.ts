import * as Schema from "effect/Schema";
import { OperationId, RequestId, TopicId } from "./model.ts";

export const MAX_PUBLIC_MESSAGE_LENGTH = 200;

const PublicMessage = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(MAX_PUBLIC_MESSAGE_LENGTH),
);
const PublicName = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

/** Public details are explicit and bounded. They cannot carry logs, commands, or capabilities. */
export const PublicFailureDetails = Schema.Struct({
  topicId: Schema.optional(TopicId),
  operationId: Schema.optional(OperationId),
  requestId: Schema.optional(RequestId),
  existingTopicId: Schema.optional(TopicId),
  existingTopicName: Schema.optional(PublicName),
  correlationId: Schema.optional(PublicName),
});
export type PublicFailureDetails = typeof PublicFailureDetails.Type;

interface OperationalCause {
  readonly internalCause: unknown;
}

interface OperationalFailureInput<Reason extends string> {
  readonly reason: Reason;
  readonly message: string;
  readonly details?: PublicFailureDetails;
  readonly internalCause: unknown;
}

function retainCause(target: object, cause: unknown): void {
  Object.defineProperty(target, "internalCause", {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
}

export function boundPublicMessage(message: string): string {
  const oneLine = message.replaceAll(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "The operation failed.";
  return oneLine.length <= MAX_PUBLIC_MESSAGE_LENGTH
    ? oneLine
    : `${oneLine.slice(0, MAX_PUBLIC_MESSAGE_LENGTH - 1)}…`;
}

export class DomainFailure extends Schema.TaggedError<DomainFailure>("Work/DomainFailure")(
  "DomainFailure",
  {
    reason: Schema.Literals([
      "invalid-input",
      "invalid-topic",
      "invalid-relationship",
      "unsupported-version",
      "not-found",
    ]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  },
) {}

export class ConfigurationFailure
  extends Schema.TaggedError<ConfigurationFailure>("Work/ConfigurationFailure")(
    "ConfigurationFailure",
    {
      reason: Schema.Literals(["missing", "invalid", "unsupported-version", "unavailable"]),
      message: PublicMessage,
    },
  )
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(
    input: OperationalFailureInput<"missing" | "invalid" | "unsupported-version" | "unavailable">,
  ) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class StorageFailure
  extends Schema.TaggedError<StorageFailure>("Work/StorageFailure")("StorageFailure", {
    reason: Schema.Literals(["unavailable", "integrity", "conflict", "migration", "backup"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(
    input: OperationalFailureInput<
      "unavailable" | "integrity" | "conflict" | "migration" | "backup"
    >,
  ) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class ProcessFailure
  extends Schema.TaggedError<ProcessFailure>("Work/ProcessFailure")("ProcessFailure", {
    reason: Schema.Literals(["spawn", "exit", "timeout", "output-limit", "interrupted"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(
    input: OperationalFailureInput<"spawn" | "exit" | "timeout" | "output-limit" | "interrupted">,
  ) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class GitFailure
  extends Schema.TaggedError<GitFailure>("Work/GitFailure")("GitFailure", {
    reason: Schema.Literals(["unavailable", "invalid-state", "race", "conflict", "ambiguous"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(
    input: OperationalFailureInput<
      "unavailable" | "invalid-state" | "race" | "conflict" | "ambiguous"
    >,
  ) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class GitHubFailure
  extends Schema.TaggedError<GitHubFailure>("Work/GitHubFailure")("GitHubFailure", {
    reason: Schema.Literals(["unavailable", "invalid-response"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(input: OperationalFailureInput<"unavailable" | "invalid-response">) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class DesktopFailure
  extends Schema.TaggedError<DesktopFailure>("Work/DesktopFailure")("DesktopFailure", {
    reason: Schema.Literals(["unavailable", "invalid-response", "ambiguous"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(input: OperationalFailureInput<"unavailable" | "invalid-response" | "ambiguous">) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class RpcFailure
  extends Schema.TaggedError<RpcFailure>("Work/RpcFailure")("RpcFailure", {
    reason: Schema.Literals([
      "incompatible",
      "invalid-request",
      "unavailable",
      "resync-required",
      "internal",
    ]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  })
  implements OperationalCause
{
  declare readonly internalCause: unknown;

  constructor(
    input: OperationalFailureInput<
      "incompatible" | "invalid-request" | "unavailable" | "resync-required" | "internal"
    >,
  ) {
    const { internalCause, ...publicInput } = input;
    super(publicInput);
    retainCause(this, internalCause);
  }
}

export class MainAgentFailure extends Schema.TaggedError<MainAgentFailure>("Work/MainAgentFailure")(
  "MainAgentFailure",
  {
    reason: Schema.Literals([
      "invalid-registration",
      "invalid-identity",
      "already-connected",
      "not-registered",
    ]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  },
) {}

export class PolicyFailure extends Schema.TaggedError<PolicyFailure>("Work/PolicyFailure")(
  "PolicyFailure",
  {
    reason: Schema.Literals(["denied", "confirmation-required", "confirmation-expired"]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  },
) {}

export class OperationFailure extends Schema.TaggedError<OperationFailure>("Work/OperationFailure")(
  "OperationFailure",
  {
    reason: Schema.Literals([
      "not-found",
      "already-terminal",
      "cancelled",
      "setup-interrupted",
      "request-conflict",
      "invalid-state",
    ]),
    message: PublicMessage,
    details: Schema.optional(PublicFailureDetails),
  },
) {}

export const PublicWorkFailure = Schema.Union([
  DomainFailure,
  ConfigurationFailure,
  StorageFailure,
  ProcessFailure,
  GitFailure,
  GitHubFailure,
  DesktopFailure,
  RpcFailure,
  MainAgentFailure,
  PolicyFailure,
  OperationFailure,
]);
export type PublicWorkFailure = typeof PublicWorkFailure.Type;
