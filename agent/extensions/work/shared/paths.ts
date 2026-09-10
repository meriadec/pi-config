import { homedir } from "node:os";
import { join } from "node:path";

export interface WorkPathOptions {
  home?: string;
  runtime?: string;
}

export interface WorkPaths {
  root: string;
  config: string;
  topics: string;
  affiliations: string;
  /** Private legacy-migration runs: journals and pre-migration manifest backups. */
  migrations: string;
  socket: string;
  topicDirectory(id: string): string;
  topicManifest(id: string): string;
  migrationDirectory(migrationId: string): string;
  migrationJournal(migrationId: string): string;
  migrationBackup(migrationId: string, topicId: string): string;
}

export function createWorkPaths(options: WorkPathOptions = {}): WorkPaths {
  const home = options.home ?? homedir();
  const runtime = options.runtime ?? process.env["XDG_RUNTIME_DIR"];
  if (runtime === undefined || runtime.length === 0) {
    throw new Error("XDG_RUNTIME_DIR is required for the work daemon socket.");
  }
  const root = join(home, "work");
  const topics = join(root, "topics");
  const migrations = join(root, "migrations");
  return {
    root,
    config: join(root, "config.json"),
    topics,
    affiliations: join(root, "affiliations.json"),
    migrations,
    socket: join(runtime, "pi-workd.sock"),
    topicDirectory: (id) => join(topics, id),
    topicManifest: (id) => join(topics, id, "topic.json"),
    migrationDirectory: (migrationId) => join(migrations, migrationId),
    migrationJournal: (migrationId) => join(migrations, migrationId, "journal.json"),
    migrationBackup: (migrationId, topicId) =>
      join(migrations, migrationId, "backup", `${topicId}.json`),
  };
}
