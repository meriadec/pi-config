import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  Branch,
  ClientId,
  DurableOperationInput,
  DurableOperationResult,
  DurableOperationState,
  DurableTopic,
  OperationId,
  Repository,
  RequestId,
  SetupStepState,
  StorageFailure,
  TopicId,
  WORK_STORAGE_SCHEMA_VERSION,
} from "../../domain/index.ts";
import { validateTopicGraph } from "../../shared/integration-chain.ts";
import { WorkConfiguration } from "../config.ts";

export const BACKUP_BUNDLE_VERSION = 1 as const;
export const BACKUP_RECEIPT_VERSION = 1 as const;
export const DAILY_BACKUP_RETENTION = 14;

export type BackupKind = "daily" | "schema-migration";

export interface BackupRequest {
  readonly kind: BackupKind;
  /** A bounded, non-secret description of the state that caused this backup. */
  readonly sourceIdentity: string;
  readonly now?: string;
}

export interface BackupResult {
  readonly status: "created" | "not-eligible";
  readonly path?: string;
}

export interface VerificationResult {
  readonly path: string;
  readonly kind: BackupKind;
  readonly createdAt: string;
  readonly storageSchemaVersion: number;
}

export interface RestoreResult {
  readonly databasePath: string;
  readonly configurationPath: string;
  readonly backupPath: string;
}

export interface StorageMaintenance {
  readonly backup: (request: BackupRequest) => Effect.Effect<BackupResult, StorageFailure>;
  readonly verify: (backupPath: string) => Effect.Effect<VerificationResult, StorageFailure>;
  readonly restore: (backupPath: string) => Effect.Effect<RestoreResult, StorageFailure>;
}

export interface StorageMaintenanceOptions {
  readonly databasePath: string;
  readonly configurationPath: string;
  readonly backupsPath: string;
  readonly daemonLockPath: string;
  /** Test-only preparation or installation checkpoint. */
  readonly faultAt?: string;
}

interface BundleFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

interface BackupManifest {
  readonly version: typeof BACKUP_BUNDLE_VERSION;
  readonly kind: BackupKind;
  readonly createdAt: string;
  readonly storageSchemaVersion: number;
  readonly source: {
    readonly identity: string;
    readonly databasePath: string;
    readonly configurationPath: string;
  };
  readonly files: ReadonlyArray<BundleFile>;
}

interface CompletionReceipt {
  readonly version: typeof BACKUP_RECEIPT_VERSION;
  readonly completedAt: string;
  readonly manifestSha256: string;
}

type LooseKey =
  | "version"
  | "kind"
  | "createdAt"
  | "storageSchemaVersion"
  | "files"
  | "source"
  | "identity"
  | "databasePath"
  | "configurationPath"
  | "path"
  | "bytes"
  | "sha256"
  | "completedAt"
  | "manifestSha256"
  | "integrity_check"
  | "id"
  | "name"
  | "note"
  | "branch"
  | "repository"
  | "setup_state"
  | "repository_available"
  | "worktree_created"
  | "setup_commands_run"
  | "completed_command_count"
  | "setup_reason"
  | "worktree_path"
  | "session_id"
  | "session_file"
  | "partition_number"
  | "parent_topic_id"
  | "origin_commit"
  | "integration_target_kind"
  | "integration_target_topic_id"
  | "chain_state"
  | "pull_request_number"
  | "created_at"
  | "updated_at"
  | "input_json"
  | "result_json";
type LooseRecord = Record<string, unknown> & Partial<Record<LooseKey, unknown>>;

const backupKinds = new Set<BackupKind>(["daily", "schema-migration"]);
const requiredTables = [
  "storage_metadata",
  "topics",
  "topic_setup",
  "topic_relationships",
  "main_agent_identities",
  "repository_state",
  "durable_operations",
  "operation_steps",
  "atomic_command_results",
  "confirmations",
  "private_capabilities",
] as const;

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StoredOperationRow = Schema.Struct({
  id: OperationId,
  client_id: ClientId,
  request_id: RequestId,
  fingerprint: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
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
const StoredStepRow = Schema.Struct({
  operation_id: OperationId,
  step_index: Schema.Natural,
  state: SetupStepState,
  started_at: Schema.String,
  completed_at: Schema.NullOr(Schema.String),
  revision: Revision,
});
const StoredRepositoryRow = Schema.Struct({
  repository: Repository,
  inferred_integration_branch: Branch,
  revision: Revision,
  updated_at: Schema.String,
});
const StoredCapabilityRow = Schema.Struct({
  capability_hash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  kind: Schema.Literals(["registration", "affiliation"]),
  topic_id: TopicId,
  expires_at: Schema.NullOr(Schema.String),
  consumed_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
});

function failure(message: string, cause: unknown): StorageFailure {
  return new StorageFailure({ reason: "backup", message, internalCause: cause });
}

function attempt<A>(message: string, run: () => Promise<A>): Effect.Effect<A, StorageFailure> {
  return Effect.tryPromise({ try: run, catch: (cause) => failure(message, cause) });
}

function checkpoint(point: string, faultAt?: string): Effect.Effect<void, StorageFailure> {
  return faultAt === point
    ? Effect.fail(failure("Injected storage maintenance failure.", point))
    : Effect.void;
}

function digest(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function timestampName(value: string): string {
  return value.replaceAll(":", "-").replaceAll(".", "-");
}

function validateRequest(request: BackupRequest): Effect.Effect<void, StorageFailure> {
  if (
    !backupKinds.has(request.kind) ||
    request.sourceIdentity.trim().length === 0 ||
    request.sourceIdentity.length > 200
  ) {
    return Effect.fail(failure("Backup request is invalid.", request));
  }
  return Effect.void;
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncDirectoryTree(join(path, entry.name));
  }
  await syncDirectory(path);
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function writePrivate(path: string, value: Uint8Array | string): Promise<void> {
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600);
}

function parseManifest(value: unknown): BackupManifest {
  if (typeof value !== "object" || value === null) throw new Error("Manifest is not an object.");
  const item = value as LooseRecord;
  if (
    Object.keys(item).toSorted().join(",") !==
      "createdAt,files,kind,source,storageSchemaVersion,version" ||
    item.version !== BACKUP_BUNDLE_VERSION ||
    typeof item.kind !== "string" ||
    !backupKinds.has(item.kind as BackupKind) ||
    typeof item.createdAt !== "string" ||
    item.storageSchemaVersion !== WORK_STORAGE_SCHEMA_VERSION ||
    !Array.isArray(item.files) ||
    typeof item.source !== "object" ||
    item.source === null
  )
    throw new Error("Manifest fields are invalid.");
  const source = item.source as LooseRecord;
  if (
    Object.keys(source).toSorted().join(",") !== "configurationPath,databasePath,identity" ||
    typeof source.identity !== "string" ||
    typeof source.databasePath !== "string" ||
    typeof source.configurationPath !== "string"
  )
    throw new Error("Manifest source is invalid.");
  const files = item.files.map((entry) => {
    if (typeof entry !== "object" || entry === null) throw new Error("Manifest file is invalid.");
    const file = entry as LooseRecord;
    if (
      Object.keys(file).toSorted().join(",") !== "bytes,path,sha256" ||
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.split("/").includes("..") ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error("Manifest file entry is invalid.");
    return file as unknown as BundleFile;
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Manifest has duplicate file paths.");
  }
  return item as unknown as BackupManifest;
}

function parseReceipt(value: unknown): CompletionReceipt {
  if (typeof value !== "object" || value === null) throw new Error("Receipt is not an object.");
  const item = value as LooseRecord;
  if (
    Object.keys(item).toSorted().join(",") !== "completedAt,manifestSha256,version" ||
    item.version !== BACKUP_RECEIPT_VERSION ||
    typeof item.completedAt !== "string" ||
    typeof item.manifestSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.manifestSha256)
  )
    throw new Error("Receipt fields are invalid.");
  return item as unknown as CompletionReceipt;
}

function decodeDatabase(path: string): void {
  const database = new Database(path, { readonly: true, create: false });
  try {
    const integrity = database.query("PRAGMA integrity_check").all() as Array<LooseRecord>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error("SQLite integrity check failed.");
    }
    const foreignKeys = database.query("PRAGMA foreign_key_check").all();
    if (foreignKeys.length !== 0) throw new Error("SQLite foreign-key check failed.");
    const tables = new Set(
      (
        database.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
    );
    for (const table of requiredTables)
      if (!tables.has(table)) throw new Error(`SQLite table ${table} is missing.`);
    const metadata = database
      .query("SELECT value FROM storage_metadata WHERE key = 'schema-version'")
      .get() as { value?: unknown } | null;
    if (metadata?.value !== String(WORK_STORAGE_SCHEMA_VERSION))
      throw new Error("Storage schema version is invalid.");

    const rows = database
      .query(`SELECT t.*, s.state AS setup_state, s.repository_available,
      s.worktree_created, s.setup_commands_run, s.completed_command_count, s.reason AS setup_reason,
      r.parent_topic_id, r.origin_commit, r.integration_target_kind, r.integration_target_topic_id,
      r.chain_state, a.session_id, a.session_file
      FROM topics t JOIN topic_setup s ON s.topic_id=t.id
      JOIN topic_relationships r ON r.topic_id=t.id
      JOIN main_agent_identities a ON a.topic_id=t.id`)
      .all() as Array<LooseRecord>;
    const topicCount = (
      database.query("SELECT count(*) AS count FROM topics").get() as { count: number }
    ).count;
    if (rows.length !== topicCount) throw new Error("A Topic is missing a required row.");
    const topics = rows.map((row) =>
      Schema.decodeUnknownSync(DurableTopic)({
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
        ...(row.integration_target_kind === null
          ? {}
          : {
              integrationTarget:
                row.integration_target_kind === "topic"
                  ? { kind: "topic", topicId: row.integration_target_topic_id }
                  : { kind: row.integration_target_kind },
            }),
        ...(row.chain_state === null ? {} : { chainState: row.chain_state }),
        ...(row.pull_request_number === null
          ? {}
          : { pullRequest: { number: row.pull_request_number } }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
    const graphError = validateTopicGraph(topics);
    if (graphError !== undefined) throw new Error(graphError.message);
    const byId = new Map(topics.map((topic) => [topic.id, topic]));
    for (const topic of topics) {
      if (
        topic.parentTopicId !== undefined &&
        byId.get(topic.parentTopicId)?.partition !== topic.partition
      ) {
        throw new Error("A Topic family does not use one Partition.");
      }
    }

    for (const row of database
      .query("SELECT input_json, result_json FROM durable_operations")
      .all() as Array<LooseRecord>) {
      Schema.decodeUnknownSync(DurableOperationInput)(JSON.parse(String(row.input_json)));
      if (row.result_json !== null)
        Schema.decodeUnknownSync(DurableOperationResult)(JSON.parse(String(row.result_json)));
    }
    for (const row of database
      .query("SELECT result_json FROM atomic_command_results")
      .all() as Array<LooseRecord>) {
      Schema.decodeUnknownSync(DurableOperationResult)(JSON.parse(String(row.result_json)));
    }
    for (const row of database.query("SELECT * FROM durable_operations").all()) {
      Schema.decodeUnknownSync(StoredOperationRow)(row);
    }
    for (const row of database.query("SELECT * FROM operation_steps").all()) {
      Schema.decodeUnknownSync(StoredStepRow)(row);
    }
    for (const row of database.query("SELECT * FROM repository_state").all()) {
      Schema.decodeUnknownSync(StoredRepositoryRow)(row);
    }
    for (const row of database.query("SELECT * FROM private_capabilities").all()) {
      Schema.decodeUnknownSync(StoredCapabilityRow)(row);
    }
  } finally {
    database.close();
  }
}

async function verifyDatabaseImage(bytes: Uint8Array, parent: string): Promise<void> {
  const path = join(parent, `.verify-${crypto.randomUUID()}.sqlite`);
  await writePrivate(path, bytes);
  try {
    decodeDatabase(path);
  } finally {
    await rm(path, { force: true });
    await rm(`${path}-wal`, { force: true });
    await rm(`${path}-shm`, { force: true });
  }
}

async function verifyPrivateTree(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error("Backup contains a symbolic link.");
  if (info.isDirectory()) {
    if ((info.mode & 0o077) !== 0) throw new Error("Backup directory is not private.");
    for (const entry of await readdir(path)) await verifyPrivateTree(join(path, entry));
    return;
  }
  if (!info.isFile() || (info.mode & 0o077) !== 0) throw new Error("Backup file is not private.");
}

async function bundleFilePaths(path: string, root = path): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) values.push(...(await bundleFilePaths(entryPath, root)));
    else values.push(entryPath.slice(root.length + 1));
  }
  return values.toSorted();
}

async function readAndVerifyBundle(
  path: string,
): Promise<{ manifest: BackupManifest; database: Uint8Array; configuration: Uint8Array }> {
  if (resolve(path) !== path) throw new Error("Backup path must be absolute and exact.");
  await verifyPrivateTree(path);
  const manifestBytes = await readFile(join(path, "manifest.json"));
  const receiptBytes = await readFile(join(path, "complete.json"));
  const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
  const receipt = parseReceipt(JSON.parse(receiptBytes.toString("utf8")));
  if (receipt.manifestSha256 !== digest(manifestBytes))
    throw new Error("Completion receipt does not match the manifest.");
  const actualPaths = await bundleFilePaths(path);
  const declaredPaths = [
    ...manifest.files.map((file) => file.path),
    "complete.json",
    "manifest.json",
  ].toSorted();
  if (
    actualPaths.length !== declaredPaths.length ||
    actualPaths.some((value, index) => value !== declaredPaths[index])
  ) {
    throw new Error("Backup files do not match the manifest.");
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(path, file.path));
    if (bytes.byteLength !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error(`Checksum failed for ${file.path}.`);
  }
  const expected = new Set(["database.sqlite", "config.json"]);
  for (const name of expected)
    if (!manifest.files.some((file) => file.path === name)) throw new Error(`${name} is missing.`);
  const database = await readFile(join(path, "database.sqlite"));
  const configuration = await readFile(join(path, "config.json"));
  Schema.decodeUnknownSync(WorkConfiguration, { onExcessProperty: "error" })(
    JSON.parse(configuration.toString("utf8")),
  );
  await verifyDatabaseImage(database, dirname(path));
  return { manifest, database, configuration };
}

async function completedManifests(
  backupsPath: string,
): Promise<Array<{ path: string; manifest: BackupManifest }>> {
  const entries = await readdir(backupsPath, { withFileTypes: true }).catch(() => []);
  const values: Array<{ path: string; manifest: BackupManifest }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(backupsPath, entry.name);
    try {
      const manifestBytes = await readFile(join(path, "manifest.json"));
      const manifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")));
      const receipt = parseReceipt(JSON.parse(await readFile(join(path, "complete.json"), "utf8")));
      if (receipt.manifestSha256 !== digest(manifestBytes)) continue;
      values.push({ path, manifest });
    } catch {
      // Incomplete evidence is not eligible for retention and is not trusted.
    }
  }
  return values;
}

async function installFile(
  path: string,
  bytes: Uint8Array,
  faultAt: string | undefined,
  point: string,
): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.restore-${crypto.randomUUID()}`);
  await writePrivate(temporary, bytes);
  await syncFile(temporary);
  if (faultAt === point) {
    await rm(temporary, { force: true });
    throw new Error(`Injected ${point} failure.`);
  }
  await rename(temporary, path);
}

/**
 * Deep storage maintenance module. Callers request backup, verification, or restore and never
 * handle SQLite export bytes, staging directories, checksums, or completion receipts.
 */
export function makeStorageMaintenance(options: StorageMaintenanceOptions): StorageMaintenance {
  const verify = (backupPath: string) =>
    attempt("Backup verification failed.", async () => {
      const { manifest } = await readAndVerifyBundle(backupPath);
      return {
        path: backupPath,
        kind: manifest.kind,
        createdAt: manifest.createdAt,
        storageSchemaVersion: manifest.storageSchemaVersion,
      };
    });

  const backup = (request: BackupRequest): Effect.Effect<BackupResult, StorageFailure> =>
    Effect.gen(function* () {
      yield* validateRequest(request);
      const now = request.now ?? new Date().toISOString();
      const database = yield* Effect.gen(function* () {
        const client = yield* SqliteClient.SqliteClient;
        return yield* client.export;
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: options.databasePath, readonly: true })),
        Effect.mapError((cause) =>
          failure("Cannot export a consistent Work database image.", cause),
        ),
      );
      yield* checkpoint("export-database", options.faultAt);
      const config = yield* attempt("Cannot read strict Work configuration.", () =>
        readFile(options.configurationPath),
      );
      yield* Effect.try({
        try: () =>
          Schema.decodeUnknownSync(WorkConfiguration, { onExcessProperty: "error" })(
            JSON.parse(config.toString("utf8")),
          ),
        catch: (cause) => failure("Cannot back up invalid Work configuration.", cause),
      });
      yield* checkpoint("read-configuration", options.faultAt);
      yield* attempt("Cannot prepare the private backup directory.", () =>
        privateDirectory(options.backupsPath),
      );

      const existing = yield* attempt("Cannot inspect completed backups.", () =>
        completedManifests(options.backupsPath),
      );
      if (request.kind === "daily") {
        const daily = existing.filter(({ manifest }) => manifest.kind === "daily");
        const latest = daily.toSorted((left, right) =>
          right.manifest.createdAt.localeCompare(left.manifest.createdAt),
        )[0];
        const databaseHash = digest(database);
        if (
          latest?.manifest.files.find((file) => file.path === "database.sqlite")?.sha256 ===
            databaseHash ||
          daily.some(({ manifest }) => manifest.createdAt.slice(0, 10) === now.slice(0, 10))
        )
          return { status: "not-eligible" };
      }

      const name = `${request.kind}-${timestampName(now)}`;
      const finalPath = join(options.backupsPath, name);
      const staging = join(options.backupsPath, `.${name}-${crypto.randomUUID()}.tmp`);
      yield* attempt("Cannot prepare a backup bundle.", async () => {
        if (
          await stat(finalPath).then(
            () => true,
            () => false,
          )
        )
          throw new Error("Backup path already exists.");
        await privateDirectory(staging);
      });
      yield* checkpoint("prepare-directory", options.faultAt);
      const installed = yield* Effect.acquireUseRelease(
        Effect.succeed(staging),
        () =>
          Effect.gen(function* () {
            yield* attempt("Cannot write the database backup.", () =>
              writePrivate(join(staging, "database.sqlite"), database),
            );
            yield* checkpoint("write-database", options.faultAt);
            yield* attempt("Cannot write the configuration backup.", () =>
              writePrivate(join(staging, "config.json"), config),
            );
            yield* checkpoint("write-configuration", options.faultAt);
            const files: BundleFile[] = [
              { path: "database.sqlite", bytes: database.byteLength, sha256: digest(database) },
              { path: "config.json", bytes: config.byteLength, sha256: digest(config) },
            ];
            const manifest: BackupManifest = {
              version: BACKUP_BUNDLE_VERSION,
              kind: request.kind,
              createdAt: now,
              storageSchemaVersion: WORK_STORAGE_SCHEMA_VERSION,
              source: {
                identity: request.sourceIdentity,
                databasePath: options.databasePath,
                configurationPath: options.configurationPath,
              },
              files,
            };
            const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
            yield* attempt("Cannot write the backup manifest.", () =>
              writePrivate(join(staging, "manifest.json"), manifestText),
            );
            yield* checkpoint("write-manifest", options.faultAt);
            const receipt: CompletionReceipt = {
              version: BACKUP_RECEIPT_VERSION,
              completedAt: now,
              manifestSha256: digest(manifestText),
            };
            yield* attempt("Cannot write the completion receipt.", () =>
              writePrivate(join(staging, "complete.json"), `${JSON.stringify(receipt, null, 2)}\n`),
            );
            yield* checkpoint("write-receipt", options.faultAt);
            yield* attempt("Cannot make the backup durable.", async () => {
              for (const file of files) await syncFile(join(staging, file.path));
              await syncFile(join(staging, "manifest.json"));
              await syncFile(join(staging, "complete.json"));
              await syncDirectoryTree(staging);
            });
            yield* checkpoint("sync-staging", options.faultAt);
            yield* checkpoint("install-directory", options.faultAt);
            yield* attempt("Cannot install the completed backup.", async () => {
              await rename(staging, finalPath);
              try {
                await syncDirectory(options.backupsPath);
              } catch (cause) {
                await rm(finalPath, { recursive: true, force: true });
                await syncDirectory(options.backupsPath);
                throw cause;
              }
            });
            return finalPath;
          }),
        (path) =>
          attempt("Cannot clean backup staging.", () =>
            rm(path, { recursive: true, force: true }),
          ).pipe(Effect.orDie),
      );
      yield* verify(installed);
      if (request.kind === "daily") {
        yield* attempt("Cannot prune daily backups.", async () => {
          const daily = (await completedManifests(options.backupsPath))
            .filter(({ manifest }) => manifest.kind === "daily")
            .toSorted((left, right) =>
              right.manifest.createdAt.localeCompare(left.manifest.createdAt),
            );
          for (const old of daily.slice(DAILY_BACKUP_RETENTION))
            await rm(old.path, { recursive: true });
          await syncDirectory(options.backupsPath);
        });
      }
      return { status: "created", path: installed };
    });

  const restore = (backupPath: string): Effect.Effect<RestoreResult, StorageFailure> =>
    attempt("Backup restore failed without changing current Work state.", async () => {
      const lock = await open(options.daemonLockPath, "wx", 0o600).catch((cause) => {
        throw new Error("The Work daemon lock is not free.", { cause });
      });
      try {
        const bundle = await readAndVerifyBundle(backupPath);
        if (options.faultAt === "verify-restore")
          throw new Error("Injected restore verification failure.");
        await privateDirectory(dirname(options.databasePath));
        await privateDirectory(dirname(options.configurationPath));
        if (options.faultAt === "prepare-restore")
          throw new Error("Injected restore preparation failure.");

        const oldDatabase = await readFile(options.databasePath).catch(() => undefined);
        const oldConfiguration = await readFile(options.configurationPath).catch(() => undefined);
        let databaseInstalled = false;
        let configurationInstalled = false;
        try {
          await installFile(
            options.databasePath,
            bundle.database,
            options.faultAt,
            "install-database",
          );
          databaseInstalled = true;
          await installFile(
            options.configurationPath,
            bundle.configuration,
            options.faultAt,
            "install-configuration",
          );
          configurationInstalled = true;
          if (options.faultAt === "sync-restore") throw new Error("Injected restore sync failure.");
          await syncDirectory(dirname(options.databasePath));
          if (dirname(options.configurationPath) !== dirname(options.databasePath))
            await syncDirectory(dirname(options.configurationPath));
        } catch (cause) {
          if (databaseInstalled) {
            if (oldDatabase === undefined) await rm(options.databasePath, { force: true });
            else
              await installFile(options.databasePath, oldDatabase, undefined, "rollback-database");
          }
          if (configurationInstalled) {
            if (oldConfiguration === undefined)
              await rm(options.configurationPath, { force: true });
            else
              await installFile(
                options.configurationPath,
                oldConfiguration,
                undefined,
                "rollback-configuration",
              );
          }
          await syncDirectory(dirname(options.databasePath));
          throw cause;
        }
        return {
          databasePath: options.databasePath,
          configurationPath: options.configurationPath,
          backupPath,
        };
      } finally {
        await lock.close();
        await rm(options.daemonLockPath, { force: true });
        await syncDirectory(dirname(options.daemonLockPath));
      }
    });

  return { backup, verify, restore };
}
