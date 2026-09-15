import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ClientId,
  DurableOperationInput,
  DurableOperationResult,
  DurableOperationState,
  OperationFailure,
  OperationId,
  RequestId,
  SetupStepState,
  StorageFailure,
  TopicId,
  WORK_STORAGE_SCHEMA_VERSION,
  type DurableOperationState as OperationState,
  type PrivateLocalCapability as Capability,
} from "../../domain/index.ts";
import {
  OperationRepository,
  type DurableOperation,
} from "../../application/operation/repository.ts";
import { topicStorageMigrations } from "./migrations.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const OperationRow = Schema.Struct({
  id: OperationId,
  client_id: ClientId,
  request_id: RequestId,
  fingerprint: Schema.String,
  topic_id: Schema.NullOr(TopicId),
  state: DurableOperationState,
  phase: Schema.String,
  input_version: Schema.Literal(1),
  input_json: Schema.String,
  result_version: Schema.NullOr(Schema.Literal(1)),
  result_json: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
  terminal_at: Schema.NullOr(Schema.String),
  revision: Revision,
});
const StepRow = Schema.Struct({
  operation_id: OperationId,
  step_index: Schema.Int,
  state: SetupStepState,
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  revision: Revision,
});
const CommandRow = Schema.Struct({ fingerprint: Schema.String, result_json: Schema.String });

export interface OperationStorageOptions {
  readonly filename: string;
  readonly busyTimeout?: SqliteClient.SqliteClientConfig["busyTimeout"];
  /** Test-only transaction checkpoint. */
  readonly faultAt?: string;
}

function storageFailure(
  reason: "unavailable" | "integrity" | "conflict" | "migration",
  message: string,
  cause: unknown,
) {
  return new StorageFailure({ reason, message, internalCause: cause });
}
function operationFailure(
  reason: "not-found" | "request-conflict" | "invalid-state",
  message: string,
  details?: { requestId?: RequestId; operationId?: OperationId },
) {
  return new OperationFailure({ reason, message, ...(details === undefined ? {} : { details }) });
}
function sqlFailure(error: SqlError) {
  return storageFailure("integrity", "SQLite rejected the operation state change.", error);
}
function catchSql<A, R>(
  effect: Effect.Effect<A, SqlError | StorageFailure | OperationFailure, R>,
): Effect.Effect<A, StorageFailure | OperationFailure, R> {
  return Effect.catchTag(effect, "SqlError", (error) => Effect.fail(sqlFailure(error)));
}
function decode<A>(
  schema: Schema.ConstraintDecoder<A>,
  value: unknown,
  subject: string,
): Effect.Effect<A, StorageFailure> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(value),
    catch: (cause) => storageFailure("integrity", `Stored ${subject} is invalid.`, cause),
  });
}
function decodeJson<A>(
  schema: Schema.ConstraintDecoder<A>,
  value: string,
  subject: string,
): Effect.Effect<A, StorageFailure> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(JSON.parse(value)),
    catch: (cause) => storageFailure("integrity", `Stored ${subject} is invalid.`, cause),
  });
}
function encodeJson<A>(
  schema: Schema.ConstraintDecoder<A>,
  value: A,
): Effect.Effect<string, StorageFailure> {
  return Effect.try({
    try: () => JSON.stringify(Schema.decodeUnknownSync(schema)(value)),
    catch: (cause) =>
      storageFailure("integrity", "Operation data does not match its schema.", cause),
  });
}
function digest(namespace: string, value: string): string {
  return createHash("sha256").update(`pi-work:${namespace}:\0`).update(value).digest("hex");
}
function capabilityHash(value: Capability): string {
  return digest("capability", Redacted.value(value));
}
function fingerprintHash(value: string): string {
  return digest("request", value);
}

const transitions: Readonly<Record<OperationState, ReadonlySet<OperationState>>> = {
  accepted: new Set(["awaiting-confirmation", "running", "failed", "cancelled"]),
  "awaiting-confirmation": new Set(["running", "failed", "cancelled"]),
  running: new Set(["running", "setup-interrupted", "succeeded", "failed", "cancelled"]),
  "setup-interrupted": new Set(["running", "failed", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};
const terminalStates = new Set<OperationState>(["succeeded", "failed", "cancelled"]);

function makeRepository(sql: SqlClient.SqlClient, faultAt?: string): OperationRepository {
  const checkpoint = (name: string) =>
    faultAt === name
      ? Effect.fail(storageFailure("unavailable", "Injected storage failure.", name))
      : Effect.void;

  const decodeOperation = (value: unknown): Effect.Effect<DurableOperation, StorageFailure> =>
    Effect.gen(function* () {
      const row = yield* decode(OperationRow, value, "operation row");
      const input = yield* decodeJson(DurableOperationInput, row.input_json, "operation input");
      const result =
        row.result_json === null
          ? undefined
          : yield* decodeJson(DurableOperationResult, row.result_json, "operation result");
      return {
        id: row.id,
        clientId: row.client_id,
        requestId: row.request_id,
        ...(row.topic_id === null ? {} : { topicId: row.topic_id }),
        state: row.state,
        phase: row.phase,
        input,
        ...(result === undefined ? {} : { result }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
        revision: row.revision,
      };
    });
  const get = (
    id: OperationId,
  ): Effect.Effect<DurableOperation, StorageFailure | OperationFailure> =>
    Effect.gen(function* () {
      const rows = yield* catchSql(sql`SELECT * FROM durable_operations WHERE id = ${id}`);
      if (rows[0] === undefined) {
        return yield* Effect.fail(
          operationFailure("not-found", "Operation does not exist.", { operationId: id }),
        );
      }
      return yield* decodeOperation(rows[0]);
    });
  const decodeStep = (value: unknown) =>
    decode(StepRow, value, "operation step").pipe(
      Effect.map((row) => ({
        operationId: row.operation_id,
        index: row.step_index,
        state: row.state,
        startedAt: row.started_at,
        ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
        revision: row.revision,
      })),
    );

  return {
    claim: (input) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const hash = fingerprintHash(input.fingerprint);
            const existing =
              yield* sql`SELECT * FROM durable_operations WHERE client_id = ${input.clientId} AND request_id = ${input.requestId}`;
            if (existing[0] !== undefined) {
              const row = yield* decode(OperationRow, existing[0], "operation row");
              if (row.fingerprint !== hash)
                return yield* Effect.fail(
                  operationFailure(
                    "request-conflict",
                    "Request identity was used with different input.",
                    { requestId: input.requestId, operationId: row.id },
                  ),
                );
              return { claimed: false as const, operation: yield* decodeOperation(existing[0]) };
            }
            const encoded = yield* encodeJson(DurableOperationInput, input.operationInput);
            yield* sql`INSERT INTO durable_operations (id, client_id, request_id, fingerprint, topic_id, state, phase, input_version, input_json, created_at, updated_at)
        VALUES (${input.id}, ${input.clientId}, ${input.requestId}, ${hash}, ${input.topicId ?? null}, 'accepted', ${input.phase}, 1, ${encoded}, ${input.now}, ${input.now})`;
            yield* checkpoint("claim:insert");
            return { claimed: true as const, operation: yield* get(input.id) };
          }),
        ),
      ),
    get,
    attachTopic: (id, topicId, expectedRevision, now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql`UPDATE durable_operations
              SET topic_id = ${topicId}, updated_at = ${now}, revision = revision + 1
              WHERE id = ${id} AND topic_id IS NULL AND revision = ${expectedRevision}
              RETURNING id`;
            if (changed[0] === undefined) {
              const current = yield* get(id);
              if (current.topicId === topicId) return current;
              return yield* Effect.fail(
                operationFailure("invalid-state", "Operation Topic association changed.", {
                  operationId: id,
                }),
              );
            }
            yield* checkpoint("operation:attach-topic");
            return yield* get(id);
          }),
        ),
      ),
    listActive: () =>
      catchSql(
        sql`SELECT * FROM durable_operations WHERE terminal_at IS NULL ORDER BY created_at, id`,
      ).pipe(Effect.flatMap((rows) => Effect.all(rows.map(decodeOperation)))),
    listAll: () =>
      catchSql(sql`SELECT * FROM durable_operations ORDER BY created_at, id`).pipe(
        Effect.flatMap((rows) => Effect.all(rows.map(decodeOperation))),
      ),
    listPendingConfirmations: () =>
      catchSql(
        sql`SELECT operation_id, expires_at FROM confirmations
            WHERE operation_id IS NOT NULL AND consumed_at IS NULL ORDER BY expires_at, operation_id`,
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.all(
            rows.map((row) =>
              decode(
                Schema.Struct({ operation_id: OperationId, expires_at: Schema.String }),
                row,
                "pending confirmation",
              ).pipe(
                Effect.map((item) => ({
                  operationId: item.operation_id,
                  expiresAt: item.expires_at,
                })),
              ),
            ),
          ),
        ),
      ),
    transition: (input) => {
      if (!transitions[input.expectedState].has(input.state))
        return Effect.fail(
          operationFailure("invalid-state", "Operation transition is not valid.", {
            operationId: input.id,
          }),
        );
      const isTerminal = terminalStates.has(input.state);
      if (isTerminal !== (input.result !== undefined))
        return Effect.fail(
          operationFailure("invalid-state", "A terminal transition needs one terminal result.", {
            operationId: input.id,
          }),
        );
      return catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const resultJson =
              input.result === undefined
                ? null
                : yield* encodeJson(DurableOperationResult, input.result);
            const changed =
              yield* sql`UPDATE durable_operations SET state = ${input.state}, phase = ${input.phase}, updated_at = ${input.now},
          terminal_at = ${isTerminal ? input.now : null}, result_version = ${isTerminal ? 1 : null}, result_json = ${resultJson}, revision = revision + 1
          WHERE id = ${input.id} AND state = ${input.expectedState} AND revision = ${input.expectedRevision} RETURNING id`;
            if (changed[0] === undefined)
              return yield* Effect.fail(
                operationFailure("invalid-state", "Operation state or revision changed.", {
                  operationId: input.id,
                }),
              );
            yield* checkpoint("transition:update");
            return yield* get(input.id);
          }),
        ),
      );
    },
    listSteps: (id) =>
      catchSql(
        sql`SELECT * FROM operation_steps WHERE operation_id = ${id} ORDER BY step_index`,
      ).pipe(Effect.flatMap((rows) => Effect.all(rows.map(decodeStep)))),
    startSetupStep: (id, index, expectedOperationRevision, now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const bumped =
              yield* sql`UPDATE durable_operations SET revision = revision + 1, updated_at = ${now}
        WHERE id = ${id} AND state = 'running' AND revision = ${expectedOperationRevision} RETURNING id`;
            if (bumped[0] === undefined)
              return yield* Effect.fail(
                operationFailure(
                  "invalid-state",
                  "Operation is not at the expected running revision.",
                  { operationId: id },
                ),
              );
            yield* sql`INSERT INTO operation_steps (operation_id, step_index, state, started_at) VALUES (${id}, ${index}, 'running', ${now})`;
            yield* checkpoint("step:start");
            const rows =
              yield* sql`SELECT * FROM operation_steps WHERE operation_id = ${id} AND step_index = ${index}`;
            return yield* decodeStep(rows[0]);
          }),
        ),
      ),
    completeSetupStep: (id, index, expectedStepRevision, now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const changed =
              yield* sql`UPDATE operation_steps SET state = 'completed', completed_at = ${now}, revision = revision + 1
        WHERE operation_id = ${id} AND step_index = ${index} AND state = 'running' AND revision = ${expectedStepRevision} RETURNING *`;
            if (changed[0] === undefined)
              return yield* Effect.fail(
                operationFailure("invalid-state", "Setup step state or revision changed.", {
                  operationId: id,
                }),
              );
            yield* checkpoint("step:complete");
            return yield* decodeStep(changed[0]);
          }),
        ),
      ),
    recoverInterruptedSetup: (now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const operations =
              yield* sql`SELECT DISTINCT operation_id FROM operation_steps WHERE state = 'running' ORDER BY operation_id`;
            const ids = yield* Effect.all(
              operations.map((row) =>
                decode(
                  Schema.Struct({ operation_id: OperationId }),
                  row,
                  "interrupted operation",
                ).pipe(Effect.map((item) => item.operation_id)),
              ),
            );
            if (ids.length === 0) return ids;
            yield* sql`UPDATE operation_steps SET state = 'interrupted', completed_at = ${now}, revision = revision + 1 WHERE state = 'running'`;
            for (const id of ids)
              yield* sql`UPDATE durable_operations SET state = 'setup-interrupted', phase = 'setup-interrupted', updated_at = ${now}, revision = revision + 1 WHERE id = ${id} AND state = 'running'`;
            yield* checkpoint("recover:interrupted");
            return ids;
          }),
        ),
      ),
    replayCommandResult: (input) =>
      Effect.gen(function* () {
        const rows = yield* catchSql(
          sql`SELECT fingerprint, result_json FROM atomic_command_results
            WHERE client_id = ${input.clientId} AND request_id = ${input.requestId}`,
        );
        if (rows[0] === undefined) return undefined;
        const existing = yield* decode(CommandRow, rows[0], "command result");
        if (existing.fingerprint !== fingerprintHash(input.fingerprint))
          return yield* Effect.fail(
            operationFailure(
              "request-conflict",
              "Request identity was used with different input.",
              { requestId: input.requestId },
            ),
          );
        return yield* decodeJson(DurableOperationResult, existing.result_json, "command result");
      }),
    storeCommandResult: (input) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const hash = fingerprintHash(input.fingerprint);
            const rows =
              yield* sql`SELECT fingerprint, result_json FROM atomic_command_results WHERE client_id = ${input.clientId} AND request_id = ${input.requestId}`;
            if (rows[0] !== undefined) {
              const existing = yield* decode(CommandRow, rows[0], "command result");
              if (existing.fingerprint !== hash)
                return yield* Effect.fail(
                  operationFailure(
                    "request-conflict",
                    "Request identity was used with different input.",
                    { requestId: input.requestId },
                  ),
                );
              return {
                stored: false,
                result: yield* decodeJson(
                  DurableOperationResult,
                  existing.result_json,
                  "command result",
                ),
              };
            }
            const encoded = yield* encodeJson(DurableOperationResult, input.result);
            yield* sql`INSERT INTO atomic_command_results (client_id, request_id, fingerprint, result_version, result_json, completed_at)
        VALUES (${input.clientId}, ${input.requestId}, ${hash}, 1, ${encoded}, ${input.now})`;
            yield* checkpoint("command:insert");
            return { stored: true, result: input.result };
          }),
        ),
      ),
    createConfirmation: (input) =>
      catchSql(sql`INSERT INTO confirmations (capability_hash, operation_id, action, expires_at)
      VALUES (${capabilityHash(input.capability)}, ${input.operationId ?? null}, ${input.action}, ${input.expiresAt})`).pipe(
        Effect.asVoid,
      ),
    consumeConfirmation: (capability, now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const hash = capabilityHash(capability);
            const rows =
              yield* sql`SELECT expires_at, consumed_at FROM confirmations WHERE capability_hash = ${hash}`;
            const row = rows[0] as { expires_at?: unknown; consumed_at?: unknown } | undefined;
            if (row === undefined || row.consumed_at !== null) return "invalid" as const;
            if (typeof row.expires_at !== "string")
              return yield* Effect.fail(
                storageFailure("integrity", "Stored confirmation is invalid.", row),
              );
            if (row.expires_at <= now) {
              yield* sql`UPDATE confirmations SET consumed_at = ${now} WHERE capability_hash = ${hash} AND consumed_at IS NULL`;
              return "expired" as const;
            }
            const changed =
              yield* sql`UPDATE confirmations SET consumed_at = ${now} WHERE capability_hash = ${hash} AND consumed_at IS NULL RETURNING capability_hash`;
            return changed[0] === undefined ? ("invalid" as const) : ("consumed" as const);
          }),
        ),
      ),
    consumeOperationConfirmation: (operationId, capability, now) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const hash = capabilityHash(capability);
            const rows =
              yield* sql`SELECT action, expires_at, consumed_at FROM confirmations WHERE capability_hash = ${hash} AND operation_id = ${operationId}`;
            const row = rows[0] as
              | { action?: unknown; expires_at?: unknown; consumed_at?: unknown }
              | undefined;
            if (row === undefined || row.consumed_at !== null)
              return { status: "invalid" as const };
            if (typeof row.expires_at !== "string" || typeof row.action !== "string")
              return yield* Effect.fail(
                storageFailure("integrity", "Stored confirmation is invalid.", row),
              );
            const changed =
              yield* sql`UPDATE confirmations SET consumed_at = ${now} WHERE capability_hash = ${hash} AND operation_id = ${operationId} AND consumed_at IS NULL RETURNING capability_hash`;
            if (changed[0] === undefined) return { status: "invalid" as const };
            return row.expires_at <= now
              ? { status: "expired" as const, action: row.action }
              : { status: "consumed" as const, action: row.action };
          }),
        ),
      ),
    expireOperationConfirmation: (operationId, now) =>
      catchSql(
        sql`UPDATE confirmations SET consumed_at = ${now}
          WHERE operation_id = ${operationId} AND consumed_at IS NULL AND expires_at <= ${now}
          RETURNING capability_hash`,
      ).pipe(Effect.map((rows) => rows[0] !== undefined)),
    storeCapability: (input) =>
      catchSql(sql`INSERT INTO private_capabilities (capability_hash, kind, topic_id, expires_at, created_at)
      VALUES (${capabilityHash(input.capability)}, ${input.kind}, ${input.topicId}, ${input.expiresAt ?? null}, ${input.now})`).pipe(
        Effect.asVoid,
      ),
    verifyCapability: (capability, kind, topicId, now) =>
      catchSql(sql`SELECT capability_hash FROM private_capabilities
      WHERE capability_hash = ${capabilityHash(capability)} AND kind = ${kind} AND topic_id = ${topicId}
        AND consumed_at IS NULL AND (expires_at IS NULL OR expires_at > ${now})`).pipe(
        Effect.map((rows) => rows[0] !== undefined),
      ),
    consumeRegistration: (capability, topicId, now) =>
      catchSql(
        sql.withTransaction(
          sql`UPDATE private_capabilities SET consumed_at = ${now} WHERE capability_hash = ${capabilityHash(capability)}
        AND kind = 'registration' AND topic_id = ${topicId} AND consumed_at IS NULL
        AND (expires_at IS NULL OR expires_at > ${now}) RETURNING capability_hash`,
        ),
      ).pipe(Effect.map((rows) => rows[0] !== undefined)),
    revokeTopicCapabilities: (topicId) =>
      catchSql(sql`DELETE FROM private_capabilities WHERE topic_id = ${topicId}`).pipe(
        Effect.asVoid,
      ),
    pruneTerminalResults: (now, maximum = 10_000) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const cutoff = new Date(
              new Date(now).getTime() - 30 * 24 * 60 * 60 * 1_000,
            ).toISOString();
            const oldOperations =
              yield* sql`DELETE FROM durable_operations WHERE terminal_at IS NOT NULL AND terminal_at < ${cutoff} RETURNING id`;
            const excessOperations = yield* sql.unsafe(
              `DELETE FROM durable_operations WHERE id IN (
        SELECT id FROM durable_operations WHERE terminal_at IS NOT NULL ORDER BY terminal_at DESC, id DESC LIMIT -1 OFFSET ?
      ) RETURNING id`,
              [maximum],
            );
            const oldCommands =
              yield* sql`DELETE FROM atomic_command_results WHERE completed_at < ${cutoff} RETURNING request_id`;
            const excessCommands = yield* sql.unsafe(
              `DELETE FROM atomic_command_results WHERE rowid IN (
        SELECT rowid FROM atomic_command_results ORDER BY completed_at DESC, client_id DESC, request_id DESC LIMIT -1 OFFSET ?
      ) RETURNING request_id`,
              [maximum],
            );
            return {
              operations: oldOperations.length + excessOperations.length,
              commands: oldCommands.length + excessCommands.length,
            };
          }),
        ),
      ),
  };
}

/** Scoped storage for operations, command replay, confirmations, and capability hashes. */
export function layer(
  options: OperationStorageOptions,
): Layer.Layer<OperationRepository, StorageFailure | OperationFailure> {
  const clientLayer = SqliteClient.layer({
    filename: options.filename,
    busyTimeout: options.busyTimeout ?? "2 seconds",
  });
  return Layer.effect(
    OperationRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* catchSql(sql`PRAGMA foreign_keys = ON`);
      yield* Migrator.make({})({ loader: topicStorageMigrations }).pipe(
        Effect.mapError((cause) =>
          storageFailure("migration", "Operation storage migration failed.", cause),
        ),
      );
      yield* Effect.promise(() => chmod(options.filename, 0o600)).pipe(
        Effect.mapError((cause) =>
          storageFailure("unavailable", "Cannot make the Work database private.", cause),
        ),
      );
      const rows = yield* catchSql(
        sql`SELECT value FROM storage_metadata WHERE key = 'schema-version'`,
      );
      if (
        (rows[0] as { value?: unknown } | undefined)?.value !== String(WORK_STORAGE_SCHEMA_VERSION)
      )
        return yield* Effect.fail(
          storageFailure("integrity", "Storage schema version does not match Work.", rows),
        );
      return makeRepository(sql, options.faultAt);
    }),
  ).pipe(Layer.provide(clientLayer));
}
