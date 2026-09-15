import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  makeStorageMaintenance,
  topicRepositoryLayer,
  TopicRepository,
  type StorageMaintenanceOptions,
} from "./index.ts";

const temporaryPaths = new Set<string>();
const configuration = {
  version: 2,
  policies: {
    defaults: {
      "repository.clone": "allow",
      "topic.create-worktree": "allow",
      "topic.run-setup": "allow",
      "terminal.open": "allow",
      "agent.open": "ask",
      "agent.reset": "ask",
      "topic.delete": "ask",
    },
    repositories: {},
    topics: {},
  },
  repositories: {},
} as const;

async function fixture(): Promise<StorageMaintenanceOptions> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-backup-"));
  temporaryPaths.add(root);
  await chmod(root, 0o700);
  const databasePath = join(root, "work.db");
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TopicRepository;
    }).pipe(Effect.provide(topicRepositoryLayer({ filename: databasePath }))),
  );
  const configurationPath = join(root, "config.json");
  await writeFile(configurationPath, `${JSON.stringify(configuration)}\n`, { mode: 0o600 });
  return {
    databasePath,
    configurationPath,
    backupsPath: join(root, "backups"),
    daemonLockPath: join(root, "work.lock"),
  };
}

afterEach(async () => {
  for (const path of temporaryPaths) {
    await rm(path, { recursive: true, force: true });
    temporaryPaths.delete(path);
  }
});

function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  return Effect.runPromise(effect);
}

async function rewriteDatabase(
  bundle: string,
  change: (database: Database) => void,
): Promise<void> {
  const databasePath = join(bundle, "database.sqlite");
  const database = new Database(databasePath);
  change(database);
  database.close();
  const bytes = await readFile(databasePath);
  const manifestPath = join(bundle, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const entry = manifest.files.find((file: { path: string }) => file.path === "database.sqlite");
  entry.bytes = bytes.byteLength;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(manifestPath, manifestText, { mode: 0o600 });
  const receiptPath = join(bundle, "complete.json");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

describe("storage maintenance", () => {
  test("creates and verifies a private bundle with a completion receipt", async () => {
    const options = await fixture();
    const maintenance = makeStorageMaintenance(options);
    const result = await run(
      maintenance.backup({
        kind: "schema-migration",
        sourceIdentity: "schema-v2",
        now: "2026-06-01T10:00:00.000Z",
      }),
    );

    expect(result.status).toBe("created");
    const path = result.path!;
    expect(await maintenance.verify(path).pipe(Effect.runPromise)).toMatchObject({
      kind: "schema-migration",
      storageSchemaVersion: 2,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o700);
    for (const file of await readdir(path)) {
      expect((await stat(join(path, file))).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects checksum, SQLite, row-schema, and graph corruption", async () => {
    const options = await fixture();
    const create = async (at: string) => {
      const result = await run(
        makeStorageMaintenance(options).backup({
          kind: "schema-migration",
          sourceIdentity: at,
          now: at,
        }),
      );
      return result.path!;
    };

    const checksum = await create("2026-06-01T10:00:00.000Z");
    await writeFile(join(checksum, "config.json"), "{}", { mode: 0o600 });
    await expect(run(makeStorageMaintenance(options).verify(checksum))).rejects.toThrow();

    const sqlite = await create("2026-06-02T10:00:00.000Z");
    await writeFile(join(sqlite, "database.sqlite"), new Uint8Array([1, 2, 3]), { mode: 0o600 });
    await expect(run(makeStorageMaintenance(options).verify(sqlite))).rejects.toThrow();

    const rowSchema = await create("2026-06-03T10:00:00.000Z");
    await rewriteDatabase(rowSchema, (database) => {
      database.run("PRAGMA ignore_check_constraints=ON");
      database.run(
        `INSERT INTO durable_operations
        (id, client_id, request_id, fingerprint, state, phase, input_version, input_json,
         result_version, result_json, created_at, updated_at, terminal_at)
        VALUES (?, ?, ?, ?, 'accepted', 'test', 1, '{}', NULL, NULL, ?, ?, NULL)`,
        [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222",
          "33333333-3333-4333-8333-333333333333",
          "a".repeat(64),
          "2026-06-01T10:00:00.000Z",
          "2026-06-01T10:00:00.000Z",
        ],
      );
    });
    await expect(run(makeStorageMaintenance(options).verify(rowSchema))).rejects.toThrow();

    const graph = await create("2026-06-04T10:00:00.000Z");
    await rewriteDatabase(graph, (database) => {
      database.run("PRAGMA ignore_check_constraints=ON");
      database.run(
        `INSERT INTO topics VALUES
        ('11111111-1111-4111-8111-111111111111','Root',NULL,'root','acme/widgets',NULL,0,NULL,?, ?,0),
        ('22222222-2222-4222-8222-222222222222','Child',NULL,'child','acme/widgets',NULL,1,NULL,?, ?,0)`,
        [
          "2026-06-01T10:00:00.000Z",
          "2026-06-01T10:00:00.000Z",
          "2026-06-01T10:00:00.000Z",
          "2026-06-01T10:00:00.000Z",
        ],
      );
      for (const id of [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]) {
        database.run("INSERT INTO topic_setup VALUES (?, 'ready',1,1,1,0,NULL)", [id]);
        database.run("INSERT INTO main_agent_identities VALUES (?, 'session', NULL)", [id]);
      }
      database.run("INSERT INTO topic_relationships VALUES (?,NULL,NULL,'topic',?,'active')", [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]);
      database.run(
        "INSERT INTO topic_relationships VALUES (?,?,?,'integration-branch',NULL,'active')",
        [
          "22222222-2222-4222-8222-222222222222",
          "11111111-1111-4111-8111-111111111111",
          "a".repeat(40),
        ],
      );
    });
    await expect(run(makeStorageMaintenance(options).verify(graph))).rejects.toThrow();
  });

  test("keeps a valid completed backup when every backup preparation stage fails", async () => {
    const options = await fixture();
    const valid = await run(
      makeStorageMaintenance(options).backup({
        kind: "schema-migration",
        sourceIdentity: "valid",
        now: "2026-06-01T10:00:00.000Z",
      }),
    );
    for (const [index, faultAt] of [
      "export-database",
      "read-configuration",
      "prepare-directory",
      "write-database",
      "write-configuration",
      "write-manifest",
      "write-receipt",
      "sync-staging",
      "install-directory",
    ].entries()) {
      await expect(
        run(
          makeStorageMaintenance({ ...options, faultAt }).backup({
            kind: "schema-migration",
            sourceIdentity: faultAt,
            now: `2026-06-${String(index + 2).padStart(2, "0")}T10:00:00.000Z`,
          }),
        ),
      ).rejects.toThrow();
      await run(makeStorageMaintenance(options).verify(valid.path!));
    }
  });

  test("restores only with a free daemon lock and rolls back every failed install stage", async () => {
    const options = await fixture();
    const backup = await run(
      makeStorageMaintenance(options).backup({
        kind: "schema-migration",
        sourceIdentity: "restore",
        now: "2026-06-01T10:00:00.000Z",
      }),
    );
    const current = new Database(options.databasePath);
    current.run("UPDATE storage_metadata SET revision = 99");
    current.close();
    const originalConfiguration = await readFile(options.configurationPath);

    for (const faultAt of [
      "verify-restore",
      "prepare-restore",
      "install-database",
      "install-configuration",
      "sync-restore",
    ]) {
      await expect(
        run(makeStorageMaintenance({ ...options, faultAt }).restore(backup.path!)),
      ).rejects.toThrow();
      const unchanged = new Database(options.databasePath);
      expect(
        unchanged.query("SELECT revision FROM storage_metadata WHERE key='schema-version'").get(),
        faultAt,
      ).toEqual({ revision: 99 });
      unchanged.close();
      expect(await readFile(options.configurationPath), faultAt).toEqual(originalConfiguration);
    }

    await writeFile(options.daemonLockPath, "held", { mode: 0o600 });
    await expect(run(makeStorageMaintenance(options).restore(backup.path!))).rejects.toThrow();
    await rm(options.daemonLockPath);
    await run(makeStorageMaintenance(options).restore(backup.path!));
    const restored = new Database(options.databasePath);
    expect(
      restored.query("SELECT revision FROM storage_metadata WHERE key='schema-version'").get(),
    ).toEqual({
      revision: 1,
    });
    restored.close();
  });

  test("backs up changed state once per day, retains 14 daily bundles, and keeps migration backups", async () => {
    const options = await fixture();
    const maintenance = makeStorageMaintenance(options);
    const migration = await run(
      maintenance.backup({
        kind: "schema-migration",
        sourceIdentity: "migration",
        now: "2026-05-01T10:00:00.000Z",
      }),
    );
    const first = await run(
      maintenance.backup({
        kind: "daily",
        sourceIdentity: "revision-0",
        now: "2026-06-01T10:00:00.000Z",
      }),
    );
    expect(first.status).toBe("created");
    expect(
      await run(
        maintenance.backup({
          kind: "daily",
          sourceIdentity: "same",
          now: "2026-06-02T10:00:00.000Z",
        }),
      ),
    ).toEqual({ status: "not-eligible" });

    for (let day = 2; day <= 16; day++) {
      const database = new Database(options.databasePath);
      database.run("UPDATE storage_metadata SET revision = revision + 1");
      database.close();
      await run(
        maintenance.backup({
          kind: "daily",
          sourceIdentity: `revision-${day}`,
          now: `2026-06-${String(day).padStart(2, "0")}T12:00:00.000Z`,
        }),
      );
    }
    const entries = await readdir(options.backupsPath);
    expect(entries.filter((name) => name.startsWith("daily-")).length).toBe(14);
    expect(entries).toContain(migration.path!.split("/").at(-1)!);
  });
});
