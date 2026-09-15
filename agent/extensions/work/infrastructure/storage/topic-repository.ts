import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { chmod } from "node:fs/promises";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Branch,
  DurableTopic,
  MainAgentDurableIdentity,
  Repository,
  StorageFailure,
  TopicId,
  TopicSetup,
  WORK_STORAGE_SCHEMA_VERSION,
  type IntegrationTarget,
} from "../../domain/index.ts";
import { validateTopicGraph } from "../../shared/integration-chain.ts";
import { topicStorageMigrations } from "./migrations.ts";

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TopicRow = Schema.Struct({
  id: TopicId,
  name: Schema.String,
  note: Schema.NullOr(Schema.String),
  branch: Branch,
  repository: Repository,
  worktree_path: Schema.NullOr(Schema.String),
  partition_number: Schema.Int,
  pull_request_number: Schema.NullOr(Schema.Int),
  created_at: Schema.String,
  updated_at: Schema.String,
  revision: Revision,
  setup_state: Schema.String,
  repository_available: Schema.Int,
  worktree_created: Schema.Int,
  setup_commands_run: Schema.Int,
  completed_command_count: Schema.Int,
  setup_reason: Schema.NullOr(Schema.String),
  session_id: Schema.String,
  session_file: Schema.NullOr(Schema.String),
  parent_topic_id: Schema.NullOr(TopicId),
  origin_commit: Schema.NullOr(Schema.String),
  integration_target_kind: Schema.NullOr(Schema.String),
  integration_target_topic_id: Schema.NullOr(TopicId),
  chain_state: Schema.NullOr(Schema.String),
});
const RepositoryStateRow = Schema.Struct({
  repository: Repository,
  inferred_integration_branch: Branch,
  revision: Revision,
  updated_at: Schema.String,
});
const RevisionRow = Schema.Struct({ revision: Revision });
const StorageMetadataRow = Schema.Struct({ value: Schema.String });

type TopicRow = typeof TopicRow.Type;
export interface RevisionedTopic {
  readonly topic: DurableTopic;
  readonly revision: number;
}
export interface RevisionedRepositoryState {
  readonly repository: Repository;
  readonly inferredIntegrationBranch: Branch;
  readonly revision: number;
  readonly updatedAt: string;
}
export interface ExpectedTopic {
  readonly topicId: TopicId;
  readonly revision: number;
}
export interface ChainEdit {
  readonly topicId: TopicId;
  readonly parentTopicId?: TopicId | null;
  readonly integrationTarget?: IntegrationTarget;
  readonly chainState?: "active" | "pending";
  /** Used when reparenting also adopts the destination family's Partition. */
  readonly partition?: number;
}
export interface ChainPlanWrite {
  readonly edits: ReadonlyArray<ChainEdit>;
  readonly expected: ReadonlyArray<ExpectedTopic>;
}
export interface PartitionWrite {
  /** The complete family selected for movement. */
  readonly family: ReadonlyArray<TopicId>;
  /** Every row whose normalized Partition changes, including other families. */
  readonly arrangement: ReadonlyArray<ExpectedTopic & { readonly partition: number }>;
}

export interface TopicRepository {
  readonly list: Effect.Effect<ReadonlyArray<RevisionedTopic>, StorageFailure>;
  readonly get: (topicId: TopicId) => Effect.Effect<RevisionedTopic, StorageFailure>;
  readonly create: (topic: DurableTopic) => Effect.Effect<RevisionedTopic, StorageFailure>;
  readonly update: (
    topic: DurableTopic,
    expectedRevision: number,
  ) => Effect.Effect<RevisionedTopic, StorageFailure>;
  readonly applyChainPlan: (
    plan: ChainPlanWrite,
  ) => Effect.Effect<ReadonlyArray<RevisionedTopic>, StorageFailure>;
  readonly updateFamilyPartition: (
    write: PartitionWrite,
  ) => Effect.Effect<ReadonlyArray<RevisionedTopic>, StorageFailure>;
  readonly deleteWithChainRepair: (
    topicId: TopicId,
    expectedRevision: number,
    repair: ChainPlanWrite,
  ) => Effect.Effect<ReadonlyArray<RevisionedTopic>, StorageFailure>;
  readonly updateSetup: (
    topicId: TopicId,
    setup: TopicSetup,
    expectedRevision: number,
  ) => Effect.Effect<RevisionedTopic, StorageFailure>;
  readonly updateMainAgent: (
    topicId: TopicId,
    identity: MainAgentDurableIdentity,
    expectedRevision: number,
  ) => Effect.Effect<RevisionedTopic, StorageFailure>;
  readonly getInferredIntegrationBranch: (
    repository: Repository,
  ) => Effect.Effect<RevisionedRepositoryState | undefined, StorageFailure>;
  readonly storeInferredIntegrationBranch: (
    repository: Repository,
    branch: Branch,
    expectedRevision: number | undefined,
    updatedAt: string,
  ) => Effect.Effect<RevisionedRepositoryState, StorageFailure>;
  readonly clearInferredIntegrationBranch: (
    repository: Repository,
    expectedRevision: number,
  ) => Effect.Effect<void, StorageFailure>;
  /** Hydrates all inferred repository state for a complete daemon snapshot. */
  readonly listInferredIntegrationBranches?: () => Effect.Effect<
    ReadonlyArray<RevisionedRepositoryState>,
    StorageFailure
  >;
}

export const TopicRepository = Context.Service<TopicRepository>("Work/TopicRepository");

export interface TopicStorageOptions {
  readonly filename: string;
  readonly busyTimeout?: SqliteClient.SqliteClientConfig["busyTimeout"];
  /** Test-only transaction checkpoint. Production callers must omit it. */
  readonly faultAt?: string;
}

const selectTopics = `
SELECT t.id, t.name, t.note, t.branch, t.repository, t.worktree_path,
  t.partition_number, t.pull_request_number, t.created_at, t.updated_at, t.revision,
  s.state AS setup_state, s.repository_available, s.worktree_created,
  s.setup_commands_run, s.completed_command_count, s.reason AS setup_reason,
  a.session_id, a.session_file, r.parent_topic_id, r.origin_commit,
  r.integration_target_kind, r.integration_target_topic_id, r.chain_state
FROM topics t
JOIN topic_setup s ON s.topic_id = t.id
JOIN main_agent_identities a ON a.topic_id = t.id
JOIN topic_relationships r ON r.topic_id = t.id`;

function storageFailure(
  reason: "unavailable" | "integrity" | "conflict" | "migration",
  message: string,
  cause: unknown,
  topicId?: TopicId,
) {
  return new StorageFailure({
    reason,
    message,
    ...(topicId === undefined ? {} : { details: { topicId } }),
    internalCause: cause,
  });
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

function sqlFailure(error: SqlError): StorageFailure {
  return storageFailure("integrity", "SQLite rejected the Topic state change.", error);
}

function catchSql<A, R>(
  effect: Effect.Effect<A, SqlError | StorageFailure, R>,
): Effect.Effect<A, StorageFailure, R> {
  return Effect.catchTag(effect, "SqlError", (error) => Effect.fail(sqlFailure(error)));
}

function targetFromRow(row: TopicRow): IntegrationTarget | undefined {
  if (row.integration_target_kind === "integration-branch") return { kind: "integration-branch" };
  if (row.integration_target_kind === "topic" && row.integration_target_topic_id !== null) {
    return { kind: "topic", topicId: row.integration_target_topic_id };
  }
  return undefined;
}

function decodeTopicRow(value: unknown): Effect.Effect<RevisionedTopic, StorageFailure> {
  return Effect.gen(function* () {
    const row = yield* decode(TopicRow, value, "Topic row");
    const candidate = {
      id: row.id,
      name: row.name,
      ...(row.note === null ? {} : { note: row.note }),
      branch: row.branch,
      repository: row.repository,
      setup: {
        state: row.setup_state,
        repositoryAvailable: row.repository_available === 1,
        worktreeCreated: row.worktree_created === 1,
        setupCommandsRun: row.setup_commands_run === 1,
        completedCommandCount: row.completed_command_count,
        ...(row.setup_reason === null ? {} : { reason: row.setup_reason }),
      },
      worktreePath: row.worktree_path,
      mainAgent: { sessionId: row.session_id, sessionFile: row.session_file },
      partition: row.partition_number,
      ...(row.parent_topic_id === null ? {} : { parentTopicId: row.parent_topic_id }),
      ...(row.origin_commit === null ? {} : { originCommit: row.origin_commit }),
      ...(targetFromRow(row) === undefined ? {} : { integrationTarget: targetFromRow(row) }),
      ...(row.chain_state === null ? {} : { chainState: row.chain_state }),
      ...(row.pull_request_number === null
        ? {}
        : { pullRequest: { number: row.pull_request_number } }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    const topic = yield* decode(DurableTopic, candidate, "Topic");
    return { topic, revision: row.revision };
  });
}

function makeRepository(sql: SqlClient.SqlClient, faultAt?: string): TopicRepository {
  const checkpoint = (name: string) =>
    faultAt === name
      ? Effect.fail(storageFailure("unavailable", "Injected storage failure.", name))
      : Effect.void;

  const rows = catchSql(sql.unsafe(selectTopics)).pipe(
    Effect.flatMap((values) => Effect.all(values.map(decodeTopicRow))),
  );
  const get = (topicId: TopicId) =>
    catchSql(sql.unsafe(`${selectTopics} WHERE t.id = ?`, [topicId])).pipe(
      Effect.flatMap((values) =>
        values[0] === undefined
          ? Effect.fail(storageFailure("integrity", "Topic does not exist.", topicId, topicId))
          : decodeTopicRow(values[0]),
      ),
    );

  const bump = (topicId: TopicId, expectedRevision: number, updatedAt?: string) =>
    catchSql(sql`
      UPDATE topics SET revision = revision + 1,
        updated_at = COALESCE(${updatedAt ?? null}, updated_at)
      WHERE id = ${topicId} AND revision = ${expectedRevision}
      RETURNING revision
    `).pipe(
      Effect.flatMap((values) =>
        values[0] === undefined
          ? Effect.fail(
              storageFailure("conflict", "Topic revision changed.", expectedRevision, topicId),
            )
          : decode(RevisionRow, values[0], "Topic revision"),
      ),
    );

  const writeSetup = (topicId: TopicId, setup: TopicSetup) =>
    catchSql(sql`
      INSERT INTO topic_setup (topic_id, state, repository_available, worktree_created,
        setup_commands_run, completed_command_count, reason)
      VALUES (${topicId}, ${setup.state}, ${Number(setup.repositoryAvailable)},
        ${Number(setup.worktreeCreated)}, ${Number(setup.setupCommandsRun)},
        ${setup.completedCommandCount}, ${setup.reason ?? null})
      ON CONFLICT(topic_id) DO UPDATE SET state = excluded.state,
        repository_available = excluded.repository_available,
        worktree_created = excluded.worktree_created,
        setup_commands_run = excluded.setup_commands_run,
        completed_command_count = excluded.completed_command_count, reason = excluded.reason
    `);

  const writeAgent = (topicId: TopicId, identity: MainAgentDurableIdentity) =>
    catchSql(sql`
      INSERT INTO main_agent_identities (topic_id, session_id, session_file)
      VALUES (${topicId}, ${identity.sessionId}, ${identity.sessionFile})
      ON CONFLICT(topic_id) DO UPDATE SET session_id = excluded.session_id,
        session_file = excluded.session_file
    `);

  const writeRelationship = (topic: DurableTopic) => {
    const targetKind = topic.integrationTarget?.kind ?? null;
    const targetId =
      topic.integrationTarget?.kind === "topic" ? topic.integrationTarget.topicId : null;
    return catchSql(sql`
      INSERT INTO topic_relationships (topic_id, parent_topic_id, origin_commit,
        integration_target_kind, integration_target_topic_id, chain_state)
      VALUES (${topic.id}, ${topic.parentTopicId ?? null}, ${topic.originCommit ?? null},
        ${targetKind}, ${targetId}, ${topic.chainState ?? null})
      ON CONFLICT(topic_id) DO UPDATE SET parent_topic_id = excluded.parent_topic_id,
        origin_commit = excluded.origin_commit,
        integration_target_kind = excluded.integration_target_kind,
        integration_target_topic_id = excluded.integration_target_topic_id,
        chain_state = excluded.chain_state
    `);
  };

  const validateGraph = (values: ReadonlyArray<RevisionedTopic>) => {
    const error = validateTopicGraph(values.map(({ topic }) => topic));
    if (error !== undefined) return Effect.fail(storageFailure("integrity", error.message, error));
    const byId = new Map(values.map((value) => [value.topic.id, value.topic]));
    for (const { topic } of values) {
      if (
        topic.parentTopicId !== undefined &&
        byId.get(topic.parentTopicId)?.partition !== topic.partition
      ) {
        return Effect.fail(
          storageFailure("integrity", "A Topic family must use one Partition.", topic.id, topic.id),
        );
      }
    }
    return Effect.void;
  };

  const applyEdits = (plan: ChainPlanWrite, validate = true) =>
    Effect.gen(function* () {
      const expected = new Map(plan.expected.map((item) => [item.topicId, item.revision]));
      if (
        expected.size !== plan.edits.length ||
        plan.edits.some((edit) => !expected.has(edit.topicId))
      ) {
        return yield* Effect.fail(
          storageFailure("integrity", "A Chain Plan needs one revision per edit.", plan),
        );
      }
      for (const edit of plan.edits) {
        const current = yield* get(edit.topicId);
        const withoutParent = (() => {
          if (edit.parentTopicId !== null) return current.topic;
          const { parentTopicId: _, ...rest } = current.topic;
          return rest;
        })();
        const topic: DurableTopic = {
          ...withoutParent,
          ...(edit.parentTopicId === undefined || edit.parentTopicId === null
            ? {}
            : { parentTopicId: edit.parentTopicId }),
          ...(edit.integrationTarget === undefined
            ? {}
            : { integrationTarget: edit.integrationTarget }),
          ...(edit.chainState === undefined ? {} : { chainState: edit.chainState }),
          ...(edit.partition === undefined ? {} : { partition: edit.partition }),
        };
        yield* bump(edit.topicId, expected.get(edit.topicId)!);
        if (edit.partition !== undefined) {
          yield* sql`UPDATE topics SET partition_number = ${edit.partition} WHERE id = ${edit.topicId}`;
        }
        yield* writeRelationship(topic);
        yield* checkpoint(`chain:${edit.topicId}`);
      }
      const committed = yield* rows;
      if (validate) yield* validateGraph(committed);
      return committed.filter(({ topic }) => expected.has(topic.id));
    });

  const create = (topic: DurableTopic) =>
    catchSql(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
        INSERT INTO topics (id, name, note, branch, repository, worktree_path, partition_number,
          pull_request_number, created_at, updated_at, revision)
        VALUES (${topic.id}, ${topic.name}, ${topic.note ?? null}, ${topic.branch}, ${topic.repository},
          ${topic.worktreePath}, ${topic.partition}, ${topic.pullRequest?.number ?? null},
          ${topic.createdAt}, ${topic.updatedAt}, 0)
      `;
          yield* checkpoint("create:topic");
          yield* writeSetup(topic.id, topic.setup);
          yield* checkpoint("create:setup");
          yield* writeRelationship(topic);
          yield* checkpoint("create:relationship");
          yield* writeAgent(topic.id, topic.mainAgent);
          yield* checkpoint("create:agent");
          const all = yield* rows;
          yield* validateGraph(all);
          return yield* get(topic.id);
        }),
      ),
    );

  const update = (topic: DurableTopic, expectedRevision: number) =>
    catchSql(
      sql.withTransaction(
        Effect.gen(function* () {
          yield* bump(topic.id, expectedRevision, topic.updatedAt);
          yield* sql`
        UPDATE topics SET name = ${topic.name}, note = ${topic.note ?? null}, branch = ${topic.branch},
          repository = ${topic.repository}, worktree_path = ${topic.worktreePath},
          partition_number = ${topic.partition}, pull_request_number = ${topic.pullRequest?.number ?? null}
        WHERE id = ${topic.id}
      `;
          yield* writeSetup(topic.id, topic.setup);
          yield* writeRelationship(topic);
          yield* writeAgent(topic.id, topic.mainAgent);
          yield* validateGraph(yield* rows);
          return yield* get(topic.id);
        }),
      ),
    );

  return {
    list: rows,
    get,
    create,
    update,
    applyChainPlan: (plan) => catchSql(sql.withTransaction(applyEdits(plan))),
    updateFamilyPartition: ({ family, arrangement }) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            if (
              family.length === 0 ||
              new Set(family).size !== family.length ||
              arrangement.length === 0 ||
              new Set(arrangement.map((item) => item.topicId)).size !== arrangement.length
            ) {
              return yield* Effect.fail(
                storageFailure(
                  "integrity",
                  "Partition family or arrangement is empty or has duplicates.",
                  { family, arrangement },
                ),
              );
            }
            const all = yield* rows;
            const requestedFamily = new Set(family);
            const first = all.find(({ topic }) => requestedFamily.has(topic.id));
            if (first === undefined) {
              return yield* Effect.fail(
                storageFailure("integrity", "Topic family does not exist.", family),
              );
            }
            const rootId = first.topic.parentTopicId ?? first.topic.id;
            const actualFamily = new Set(
              all
                .filter(({ topic }) => topic.id === rootId || topic.parentTopicId === rootId)
                .map(({ topic }) => topic.id),
            );
            if (
              actualFamily.size !== requestedFamily.size ||
              [...actualFamily].some((id) => !requestedFamily.has(id))
            ) {
              return yield* Effect.fail(
                storageFailure(
                  "integrity",
                  "Partition update must identify the complete family.",
                  family,
                ),
              );
            }
            const changed = new Set(arrangement.map((item) => item.topicId));
            for (const item of arrangement) {
              yield* bump(item.topicId, item.revision);
              yield* sql`UPDATE topics SET partition_number = ${item.partition} WHERE id = ${item.topicId}`;
              yield* checkpoint(`partition:${item.topicId}`);
            }
            const committed = yield* rows;
            yield* validateGraph(committed);
            return committed.filter(({ topic }) => changed.has(topic.id));
          }),
        ),
      ),
    deleteWithChainRepair: (topicId, expectedRevision, repair) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            if (repair.edits.some((edit) => edit.topicId === topicId)) {
              return yield* Effect.fail(
                storageFailure(
                  "integrity",
                  "Chain repair cannot edit the deleted Topic.",
                  repair,
                  topicId,
                ),
              );
            }
            yield* bump(topicId, expectedRevision);
            // The savepoint keeps this composable when deletion already owns the outer transaction.
            yield* sql.withTransaction(applyEdits(repair, false));
            yield* sql`DELETE FROM main_agent_identities WHERE topic_id = ${topicId}`;
            yield* checkpoint("delete:agent");
            yield* sql`DELETE FROM topic_setup WHERE topic_id = ${topicId}`;
            yield* checkpoint("delete:setup");
            yield* sql`DELETE FROM topic_relationships WHERE topic_id = ${topicId}`;
            yield* checkpoint("delete:relationship");
            yield* sql`DELETE FROM topics WHERE id = ${topicId}`;
            yield* checkpoint("delete:topic");
            const committed = yield* rows;
            yield* validateGraph(committed);
            return committed;
          }),
        ),
      ),
    updateSetup: (topicId, setup, expectedRevision) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* bump(topicId, expectedRevision);
            yield* writeSetup(topicId, setup);
            return yield* get(topicId);
          }),
        ),
      ),
    updateMainAgent: (topicId, identity, expectedRevision) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* bump(topicId, expectedRevision);
            yield* writeAgent(topicId, identity);
            return yield* get(topicId);
          }),
        ),
      ),
    getInferredIntegrationBranch: (repository) =>
      catchSql(sql`
      SELECT repository, inferred_integration_branch, revision, updated_at
      FROM repository_state WHERE repository = ${repository}
    `).pipe(
        Effect.flatMap((values) =>
          values[0] === undefined
            ? Effect.succeed(undefined)
            : decode(RepositoryStateRow, values[0], "repository state").pipe(
                Effect.map((row) => ({
                  repository: row.repository,
                  inferredIntegrationBranch: row.inferred_integration_branch,
                  revision: row.revision,
                  updatedAt: row.updated_at,
                })),
              ),
        ),
      ),
    listInferredIntegrationBranches: () =>
      catchSql(sql`
        SELECT repository, inferred_integration_branch, revision, updated_at
        FROM repository_state ORDER BY repository
      `).pipe(
        Effect.flatMap((values) =>
          Effect.all(
            values.map((value) =>
              decode(RepositoryStateRow, value, "repository state").pipe(
                Effect.map((row) => ({
                  repository: row.repository,
                  inferredIntegrationBranch: row.inferred_integration_branch,
                  revision: row.revision,
                  updatedAt: row.updated_at,
                })),
              ),
            ),
          ),
        ),
      ),
    storeInferredIntegrationBranch: (repository, branch, expectedRevision, updatedAt) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            if (expectedRevision === undefined) {
              yield* sql`INSERT INTO repository_state (repository, inferred_integration_branch, revision, updated_at)
          VALUES (${repository}, ${branch}, 0, ${updatedAt})`;
            } else {
              const changed =
                yield* sql`UPDATE repository_state SET inferred_integration_branch = ${branch},
          revision = revision + 1, updated_at = ${updatedAt}
          WHERE repository = ${repository} AND revision = ${expectedRevision} RETURNING revision`;
              if (changed[0] === undefined)
                return yield* Effect.fail(
                  storageFailure(
                    "conflict",
                    "Repository state revision changed.",
                    expectedRevision,
                  ),
                );
              yield* decode(RevisionRow, changed[0], "repository revision");
            }
            const result =
              yield* catchSql(sql`SELECT repository, inferred_integration_branch, revision, updated_at
        FROM repository_state WHERE repository = ${repository}`);
            const row = yield* decode(RepositoryStateRow, result[0], "repository state");
            return {
              repository: row.repository,
              inferredIntegrationBranch: row.inferred_integration_branch,
              revision: row.revision,
              updatedAt: row.updated_at,
            };
          }),
        ),
      ),
    clearInferredIntegrationBranch: (repository, expectedRevision) =>
      catchSql(
        sql.withTransaction(
          Effect.gen(function* () {
            const removed = yield* sql`DELETE FROM repository_state
              WHERE repository = ${repository} AND revision = ${expectedRevision}
              RETURNING revision`;
            if (removed[0] === undefined) {
              return yield* Effect.fail(
                storageFailure("conflict", "Repository state revision changed.", expectedRevision),
              );
            }
          }),
        ),
      ),
  };
}

/** A scoped repository Layer. The SQL client and its transaction capability do not escape it. */
export function layer(options: TopicStorageOptions): Layer.Layer<TopicRepository, StorageFailure> {
  const clientLayer = SqliteClient.layer({
    filename: options.filename,
    busyTimeout: options.busyTimeout ?? "2 seconds",
  });
  const repositoryLayer = Layer.effect(
    TopicRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* catchSql(sql`PRAGMA foreign_keys = ON`);
      yield* Migrator.make({})({ loader: topicStorageMigrations }).pipe(
        Effect.mapError((cause) =>
          storageFailure("migration", "Topic storage migration failed.", cause),
        ),
      );
      yield* Effect.promise(() => chmod(options.filename, 0o600)).pipe(
        Effect.mapError((cause) =>
          storageFailure("unavailable", "Cannot make the Work database private.", cause),
        ),
      );
      const metadata = yield* catchSql(
        sql`SELECT value FROM storage_metadata WHERE key = 'schema-version'`,
      );
      const schemaVersion = yield* decode(StorageMetadataRow, metadata[0], "storage metadata");
      if (schemaVersion.value !== String(WORK_STORAGE_SCHEMA_VERSION)) {
        return yield* Effect.fail(
          storageFailure("integrity", "Storage schema version does not match Work.", metadata),
        );
      }
      return makeRepository(sql, options.faultAt);
    }),
  ).pipe(Layer.provide(clientLayer));
  return repositoryLayer;
}
