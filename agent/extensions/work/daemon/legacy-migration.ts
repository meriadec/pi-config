import { chmod, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { WorkDataError, boundMessage, writeJsonAtomic } from "../shared/index.ts";
import type { TopicManifest, WorkPaths } from "../shared/index.ts";
import type { LegacyMigrationFamily } from "../shared/legacy-migration.ts";

/**
 * The durable recovery record of one legacy migration run. Before any manifest changes, the
 * run writes a private pre-migration backup of every touched Topic manifest and a journal of
 * the planned families. Each write point updates the journal atomically, so an interrupted
 * run has one deterministic outcome: a family that the journal records as complete stays
 * migrated, and a family that was still in progress is rolled back from its backups. The
 * journal never contains Git commands; it only stores metadata.
 */

/** Journal format version. A journal of another version is left untouched. */
export const MIGRATION_JOURNAL_VERSION = 1 as const;

/** Settled migration runs kept on disk, newest first. Older runs are pruned. */
export const MIGRATION_RETENTION = 10;

export type MigrationRunState = "applying" | "settled";

export interface MigrationJournalFamily {
  parentTopicId: string;
  topicIds: readonly string[];
}

export interface MigrationJournal {
  version: typeof MIGRATION_JOURNAL_VERSION;
  id: string;
  createdAt: string;
  state: MigrationRunState;
  families: readonly MigrationJournalFamily[];
  /** Parent Topic ids whose complete family is durably written. */
  completed: readonly string[];
  /** Parent Topic ids that a recovery rolled back from the manifest backups. */
  rolledBack: readonly string[];
}

/** One family of an approved preview, with the manifests that it will replace. */
export interface MigrationWrite {
  parentTopicId: string;
  /** Complete replacement manifests, applied in this order. */
  manifests: readonly TopicManifest[];
}

export interface MigrationRunResult {
  migrationId: string;
  appliedParentTopicIds: readonly string[];
  rolledBackParentTopicIds: readonly string[];
}

export interface MigrationRecovery {
  migrationId: string;
  restoredTopicIds: readonly string[];
}

/** Writes one durable manifest. It is the Topic store update, injected for testability. */
export type MigrationManifestWriter = (manifest: TopicManifest) => Promise<TopicManifest>;

export interface LegacyMigrationJournalOptions {
  paths: WorkPaths;
  now?: () => Date;
  generateId?: () => string;
  retention?: number;
}

export class LegacyMigrationJournal {
  private readonly paths: WorkPaths;
  private readonly now: () => Date;
  private readonly generateId: () => string;
  private readonly retention: number;

  constructor(options: LegacyMigrationJournalOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => randomRunId());
    this.retention = options.retention ?? MIGRATION_RETENTION;
  }

  /**
   * Applies approved families one after the other. Every family is written completely or
   * rolled back from its backups, so no family is ever half migrated. A family that fails
   * does not stop the remaining families.
   */
  async run(
    writes: readonly MigrationWrite[],
    previous: ReadonlyMap<string, TopicManifest>,
    write: MigrationManifestWriter,
  ): Promise<MigrationRunResult> {
    const migrationId = this.generateId();
    const directory = this.paths.migrationDirectory(migrationId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    for (const family of writes) {
      for (const manifest of family.manifests) {
        const backup = previous.get(manifest.id);
        if (backup === undefined) {
          throw new WorkDataError(
            "missing-migration-backup",
            boundMessage(`No pre-migration backup exists for Topic ${manifest.id}.`),
          );
        }
        await writeJsonAtomic(this.paths.migrationBackup(migrationId, manifest.id), backup);
      }
    }

    let journal: MigrationJournal = {
      version: MIGRATION_JOURNAL_VERSION,
      id: migrationId,
      createdAt: this.now().toISOString(),
      state: "applying",
      families: writes.map((family) => ({
        parentTopicId: family.parentTopicId,
        topicIds: family.manifests.map((manifest) => manifest.id),
      })),
      completed: [],
      rolledBack: [],
    };
    await this.write(journal);

    for (const family of writes) {
      try {
        for (const manifest of family.manifests) await write(manifest);
        journal = { ...journal, completed: [...journal.completed, family.parentTopicId] };
      } catch {
        const topicIds = family.manifests.map((manifest) => manifest.id);
        await this.restore(migrationId, topicIds, previous, write);
        journal = { ...journal, rolledBack: [...journal.rolledBack, family.parentTopicId] };
      }
      await this.write(journal);
    }
    journal = { ...journal, state: "settled" };
    await this.write(journal);
    await this.prune();
    return {
      migrationId,
      appliedParentTopicIds: journal.completed,
      rolledBackParentTopicIds: journal.rolledBack,
    };
  }

  /**
   * Settles every interrupted run. A family that the journal does not record as complete is
   * restored from its pre-migration backups, so recovery never leaves a mixed chain.
   */
  async recover(write: MigrationManifestWriter): Promise<MigrationRecovery[]> {
    const recoveries: MigrationRecovery[] = [];
    for (const migrationId of await this.runIds()) {
      const journal = await this.read(migrationId);
      if (journal === undefined || journal.state !== "applying") continue;
      const restoredTopicIds: string[] = [];
      const rolledBack = new Set(journal.rolledBack);
      for (const family of journal.families) {
        if (journal.completed.includes(family.parentTopicId)) continue;
        for (const topicId of family.topicIds) {
          const backup = await this.readBackup(migrationId, topicId);
          if (backup === undefined) continue;
          await write(backup).catch(() => undefined);
          restoredTopicIds.push(topicId);
        }
        rolledBack.add(family.parentTopicId);
      }
      await this.write({ ...journal, state: "settled", rolledBack: [...rolledBack] });
      recoveries.push({ migrationId, restoredTopicIds });
    }
    await this.prune();
    return recoveries;
  }

  /** The stored journal of one run, or undefined when it is missing or unreadable. */
  async read(migrationId: string): Promise<MigrationJournal | undefined> {
    const text = await readFile(this.paths.migrationJournal(migrationId), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) return undefined;
    try {
      return parseJournal(JSON.parse(text), migrationId);
    } catch {
      return undefined;
    }
  }

  private async readBackup(
    migrationId: string,
    topicId: string,
  ): Promise<TopicManifest | undefined> {
    const text = await readFile(this.paths.migrationBackup(migrationId, topicId), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return value !== null && typeof value === "object" && (value as TopicManifest).id === topicId
        ? (value as TopicManifest)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async restore(
    migrationId: string,
    topicIds: readonly string[],
    previous: ReadonlyMap<string, TopicManifest>,
    write: MigrationManifestWriter,
  ): Promise<void> {
    for (const topicId of topicIds) {
      const backup = previous.get(topicId) ?? (await this.readBackup(migrationId, topicId));
      if (backup === undefined) continue;
      await write(backup).catch(() => undefined);
    }
  }

  private async write(journal: MigrationJournal): Promise<void> {
    await writeJsonAtomic(this.paths.migrationJournal(journal.id), journal);
  }

  private async runIds(): Promise<string[]> {
    const entries = await readdir(this.paths.migrations, { withFileTypes: true }).catch(
      () => undefined,
    );
    if (entries === undefined) return [];
    return entries
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  }

  /** Keeps the newest settled runs and removes older ones, so backups do not grow forever. */
  private async prune(): Promise<void> {
    const ids = (await this.runIds()).toReversed();
    const settled: string[] = [];
    for (const id of ids) {
      const journal = await this.read(id);
      if (journal !== undefined && journal.state === "applying") continue;
      settled.push(id);
    }
    for (const id of settled.slice(this.retention)) {
      await rm(this.paths.migrationDirectory(id), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function parseJournal(value: unknown, migrationId: string): MigrationJournal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record["version"] !== MIGRATION_JOURNAL_VERSION) return undefined;
  if (record["id"] !== migrationId) return undefined;
  const state = record["state"];
  if (state !== "applying" && state !== "settled") return undefined;
  const families = record["families"];
  if (!Array.isArray(families)) return undefined;
  const parsed: MigrationJournalFamily[] = [];
  for (const entry of families) {
    if (entry === null || typeof entry !== "object") return undefined;
    const family = entry as Record<string, unknown>;
    const parentTopicId = family["parentTopicId"];
    const topicIds = family["topicIds"];
    if (typeof parentTopicId !== "string" || !Array.isArray(topicIds)) return undefined;
    if (!topicIds.every((id): id is string => typeof id === "string")) return undefined;
    parsed.push({ parentTopicId, topicIds });
  }
  return {
    version: MIGRATION_JOURNAL_VERSION,
    id: migrationId,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
    state,
    families: parsed,
    completed: stringList(record["completed"]),
    rolledBack: stringList(record["rolledBack"]),
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

const RUN_ID_PATTERN = /^[0-9a-z-]{1,64}$/;

function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

function randomRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-").toLowerCase()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/** The families of an approved preview, expressed as ordered manifest replacements. */
export function migrationWrites(
  families: readonly LegacyMigrationFamily[],
  manifests: ReadonlyMap<string, TopicManifest>,
): MigrationWrite[] {
  const writes: MigrationWrite[] = [];
  for (const family of families) {
    const parent = manifests.get(family.parentTopicId);
    if (parent === undefined) continue;
    const children = family.children.map((child) => {
      const manifest = manifests.get(child.topicId);
      return manifest === undefined
        ? undefined
        : {
            ...manifest,
            parentTopicId: family.parentTopicId,
            integrationTarget: child.integrationTarget,
            chainState: "active" as const,
          };
    });
    if (children.some((child) => child === undefined)) continue;
    writes.push({
      parentTopicId: family.parentTopicId,
      // The Parent Topic is written last, so its family becomes complete in one final write.
      manifests: [
        ...(children as TopicManifest[]),
        { ...parent, integrationTarget: family.parentIntegrationTarget },
      ],
    });
  }
  return writes;
}
