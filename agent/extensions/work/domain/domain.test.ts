import { describe, expect, test } from "bun:test";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  AbsolutePath,
  Branch,
  ClientId,
  DomainFailure,
  DurableTopic,
  FullCommitSha,
  OperationId,
  PrivateLocalCapability,
  ProtocolVersion,
  Repository,
  RequestId,
  StorageFailure,
  StorageSchemaVersion,
  TopicId,
  WORK_PROTOCOL_VERSION,
  WORK_STORAGE_SCHEMA_VERSION,
  boundPublicMessage,
} from "./index.ts";

const TOPIC_ID = "123e4567-e89b-42d3-a456-426614174000";
const OPERATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const CLIENT_ID = "323e4567-e89b-42d3-a456-426614174000";
const REQUEST_ID = "423e4567-e89b-42d3-a456-426614174000";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function decodeUnknown<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
): S["Type"] {
  return (Schema.decodeUnknownSync(schema) as (value: unknown) => S["Type"])(input);
}

function roundTrip<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  input: unknown,
): S["Type"] {
  const decoded = decodeUnknown(schema, input);
  const encoded = (Schema.encodeUnknownSync(schema) as (value: unknown) => S["Encoded"])(decoded);
  return decodeUnknown(schema, encoded);
}

const durableTopicInput = {
  id: TOPIC_ID,
  name: "Effect control plane",
  branch: "effect/control-plane",
  repository: "LedgerHQ/revault",
  setup: {
    state: "setup-interrupted",
    repositoryAvailable: true,
    worktreeCreated: true,
    setupCommandsRun: false,
    completedCommandCount: 1,
    reason: "Supervision ended while command 2 was running.",
  },
  worktreePath: "/home/person/work/revault.effect-control-plane",
  mainAgent: { sessionId: "session-1", sessionFile: "/home/person/.pi/session.jsonl" },
  partition: 0,
  integrationTarget: { kind: "integration-branch" },
  createdAt: "2026-09-15T10:00:00.000Z",
  updatedAt: "2026-09-15T10:01:00.000Z",
};

describe("Work domain codecs", () => {
  test("round-trips branded seam identities", () => {
    const values = [
      [TopicId, TOPIC_ID],
      [OperationId, OPERATION_ID],
      [ClientId, CLIENT_ID],
      [RequestId, REQUEST_ID],
      [Branch, "feature/topic"],
      [Repository, "LedgerHQ/revault"],
      [FullCommitSha, COMMIT],
      [AbsolutePath, "/home/person/work"],
      [ProtocolVersion, WORK_PROTOCOL_VERSION],
      [StorageSchemaVersion, WORK_STORAGE_SCHEMA_VERSION],
    ] as const;

    for (const [schema, input] of values) {
      expect(roundTrip(schema as Schema.Codec<unknown, unknown, never, never>, input)).toEqual(
        input,
      );
    }
  });

  test("round-trips immutable durable Topic data including Interrupted Setup", () => {
    const topic = roundTrip(DurableTopic, durableTopicInput);

    expect(topic.setup.state).toBe("setup-interrupted");
    expect(topic).not.toHaveProperty("integrationStatus");
    expect(topic).not.toHaveProperty("gitOperationState");
  });

  test("rejects invalid external identity and Topic data", () => {
    const invalid = [
      [TopicId, "topic-1"],
      [OperationId, "operation-1"],
      [Branch, "bad..branch"],
      [Repository, "not-a-repository"],
      [Repository, "owner/.."],
      [FullCommitSha, COMMIT.toUpperCase()],
      [AbsolutePath, "relative/path"],
      [ProtocolVersion, 0],
      [StorageSchemaVersion, 1.5],
    ] as const;

    for (const [schema, input] of invalid) {
      expect(() =>
        decodeUnknown(schema as Schema.Codec<unknown, unknown, never, never>, input),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(DurableTopic)({
        ...durableTopicInput,
        setup: { ...durableTopicInput.setup, state: "interrupted" },
      }),
    ).toThrow();
  });

  test("uses explicit compatible protocol and storage versions", () => {
    expect(Number(decodeUnknown(ProtocolVersion, WORK_PROTOCOL_VERSION))).toBe(3);
    expect(Number(decodeUnknown(StorageSchemaVersion, WORK_STORAGE_SCHEMA_VERSION))).toBe(2);
    expect(() => decodeUnknown(ProtocolVersion, "1")).toThrow();
    expect(() => decodeUnknown(StorageSchemaVersion, 0)).toThrow();
  });
});

describe("Work failures and private values", () => {
  test("redacts capabilities and refuses default encoding", () => {
    const capability = Schema.decodeUnknownSync(PrivateLocalCapability)("local-secret-value");

    expect(String(capability)).not.toContain("local-secret-value");
    expect(JSON.stringify(capability)).not.toContain("local-secret-value");
    expect(Redacted.value(capability)).toBe("local-secret-value");
    expect(() => Schema.encodeSync(PrivateLocalCapability)(capability)).toThrow();
  });

  test("round-trips a bounded public domain failure", () => {
    const failure = new DomainFailure({
      reason: "invalid-topic",
      message: "Topic data is invalid.",
      details: { existingTopicId: decodeUnknown(TopicId, TOPIC_ID) },
    });

    const decoded = roundTrip(DomainFailure, failure);
    expect(decoded._tag).toBe("DomainFailure");
    expect(String(decoded.details?.existingTopicId)).toBe(TOPIC_ID);
  });

  test("retains an operational cause but excludes it from the public codec", () => {
    const internalCause = new Error("secret process output");
    const failure = new StorageFailure({
      reason: "unavailable",
      message: "Work storage is unavailable.",
      internalCause,
    });
    const encoded = Schema.encodeSync(StorageFailure)(failure);

    expect(failure.internalCause).toBe(internalCause);
    expect(JSON.stringify(encoded)).not.toContain("secret process output");
    expect(encoded).not.toHaveProperty("internalCause");
  });

  test("bounds public messages", () => {
    const message = boundPublicMessage(`  failure\n${"x".repeat(300)}  `);
    expect(message).not.toContain("\n");
    expect(message.length).toBe(200);
    expect(message.endsWith("…")).toBe(true);
  });
});
