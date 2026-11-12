import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { homedir } from "node:os";
import { join } from "node:path";

export const SESSIONS_GLOB = join(homedir(), ".pi/agent/sessions/*/*.jsonl");

/** Open an in-memory DuckDB over the raw session JSONL. ~2s for 3 GB; the JSONL stays the source of truth. */
export async function openSessions(glob = SESSIONS_GLOB): Promise<DuckDBConnection> {
  const db = await (await DuckDBInstance.create(":memory:")).connect();
  const src = glob.replaceAll("'", "''");
  await db.run(`create table messages as
    select filename as file, timestamp::timestamp as ts, message
    from read_json('${src}', format='newline_delimited',
      columns={type:'VARCHAR', timestamp:'VARCHAR', message:'JSON'},
      filename=true, ignore_errors=true, maximum_object_size=268435456)
    where type = 'message'`);
  await db.run(`create view tool_results as
    select file, ts, message->>'toolName' as tool,
      coalesce((message->>'isError')::boolean, false) as is_error,
      length(message->>'content') as size,
      substr(message->>'content', 1, 600) as head,
      substr(message->>'content', greatest(length(message->>'content') - 300, 1)) as tail
    from messages where message->>'role' = 'toolResult'`);
  return db;
}

export async function rows<T = Record<string, unknown>>(
  db: DuckDBConnection,
  sql: string,
): Promise<T[]> {
  const reader = await db.runAndReadAll(sql);
  return reader.getRowObjectsJson() as T[];
}
