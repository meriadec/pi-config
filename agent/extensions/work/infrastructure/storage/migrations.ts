import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Migrator from "effect/unstable/sql/Migrator";

const migrationFiles = [
  [1, "topic_storage", "0001_topic_storage.sql"],
  [2, "operation_storage", "0002_operation_storage.sql"],
] as const;

function loadSqlMigration(file: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const source = yield* Effect.promise(() =>
      Bun.file(`${import.meta.dir}/migrations/${file}`).text(),
    );
    const statements = source
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    for (const statement of statements) yield* sql.unsafe(statement);
  });
}

/** Numbered, checked-in SQL migrations used by the Work database. */
export const topicStorageMigrations: Migrator.Loader = Effect.succeed(
  migrationFiles.map(
    ([id, name, file]) => [id, name, Effect.succeed(loadSqlMigration(file))] as const,
  ),
);
