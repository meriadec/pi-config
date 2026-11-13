/** Load per-session facts for models.ts from the DuckDB views. */
import type { DuckDBConnection } from "@duckdb/node-api";
import { rows } from "./db.ts";
import type { SessionRow } from "./sessions.ts";
import type { ModelSessionInput } from "./models.ts";
import { loadTailInputs } from "./tail-data.ts";

export async function loadModelInputs(
  db: DuckDBConnection,
  sessions: SessionRow[],
  labelOf: (file: string) => string,
  originOf: (s: SessionRow) => string,
  keep: (label: string) => boolean,
): Promise<ModelSessionInput[]> {
  const tail = await loadTailInputs(
    db,
    sessions,
    labelOf,
    originOf,
    (l, o) => o === "human" && keep(l),
  );
  const [extra, results, users] = await Promise.all([
    rows<{ file: string; stop: string }>(
      db,
      "select file, count(*) filter (where message->>'stopReason' = 'error') stop from messages group by 1",
    ),
    rows<{ file: string; n: string }>(db, "select file, count(*) n from tool_results group by 1"),
    rows<{ file: string; text: string }>(
      db,
      `select file, text from (
         select file, row_number() over (partition by file order by ts desc) rn,
           count(*) over (partition by file) total,
           substr(case when json_type(c) = 'ARRAY' then coalesce(c->>'$[0].text', '') else trim(both '"' from c::varchar) end, 1, 1500) text
         from (select file, ts, message->'content' c from messages where message->>'role' = 'user'))
       where rn <= 3 and rn < total order by file, rn desc`,
    ),
  ]);
  const stop = new Map(extra.map((r) => [r.file, Number(r.stop)]));
  const res = new Map(results.map((r) => [r.file, Number(r.n)]));
  const last = new Map<string, string[]>();
  for (const u of users) last.set(u.file, [...(last.get(u.file) ?? []), u.text]);
  return tail.map((t) => ({
    file: t.file,
    label: t.label,
    usage: t.usage,
    timestamps: t.timestamps,
    toolResults: res.get(t.file) ?? 0,
    toolErrors: t.toolErrors,
    aborts: t.aborts,
    stopErrors: stop.get(t.file) ?? 0,
    userMessages: t.userMessages,
    lastUsers: last.get(t.file) ?? [],
  }));
}
