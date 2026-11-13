/** Load per-session raw facts for tail.ts from the DuckDB views. */
import type { DuckDBConnection } from "@duckdb/node-api";
import { rows, SESSIONS_GLOB } from "./db.ts";
import { retryLoops } from "./reports.ts";
import type { SessionRow } from "./sessions.ts";
import type { TailInput } from "./tail.ts";

function group<T extends { file: string }>(xs: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const g = m.get(x.file);
    if (g) g.push(x);
    else m.set(x.file, [x]);
  }
  return m;
}

export async function loadTailInputs(
  db: DuckDBConnection,
  sessions: SessionRow[],
  labelOf: (file: string) => string,
  originOf: (s: SessionRow) => string,
  keep: (label: string, origin: string) => boolean,
): Promise<TailInput[]> {
  const src = SESSIONS_GLOB.replaceAll("'", "''");
  const [usage, calls, cmds, reads, comps, counts, stamps, loops] = await Promise.all([
    rows<Record<string, string | null>>(
      db,
      `select file, message->>'model' as model,
         (message->'usage'->>'input')::double as input, (message->'usage'->>'output')::double as output,
         (message->'usage'->>'cacheRead')::double as cacheRead, (message->'usage'->>'cacheWrite')::double as cacheWrite,
         coalesce((message->'usage'->'cost'->>'total')::double, 0) as notional
       from messages where message->>'role' = 'assistant' and (message->'usage') is not null order by file, ts`,
    ),
    rows<{ file: string; tool: string; n: string }>(
      db,
      "select file, tool, count(*) n from tool_calls group by 1, 2",
    ),
    rows<{ file: string; command: string }>(
      db,
      "select file, command from tool_calls where tool = 'bash' and command is not null",
    ),
    rows<{ file: string; tool: string; p: string; slice: string; size: string | null }>(
      db,
      `select c.file, c.tool, c.args->>'path' as p, coalesce(c.args->>'offset', '') || ':' || coalesce(c.args->>'limit', '') as slice, r.size
       from tool_calls c left join tool_results r using (call_id)
       where c.tool in ('read', 'edit', 'write') and c.args->>'path' is not null order by c.file, c.ts`,
    ),
    rows<{ file: string; n: string }>(
      db,
      `select filename as file, count(*) n
       from read_json('${src}', format='newline_delimited', columns={type:'VARCHAR'},
         filename=true, ignore_errors=true, maximum_object_size=268435456)
       where type = 'compaction' group by 1`,
    ),
    rows<{ file: string; users: string; aborts: string }>(
      db,
      `select file, count(*) filter (where message->>'role' = 'user') users,
         count(*) filter (where message->>'stopReason' = 'aborted') aborts
       from messages group by 1`,
    ),
    rows<{ file: string; ms: string }>(
      db,
      "select file, epoch_ms(ts) ms from messages order by file, ts",
    ),
    retryLoops(db),
  ]);
  const errs = new Map(
    (
      await rows<{ file: string; n: string }>(
        db,
        "select file, count(*) n from tool_results where is_error group by 1",
      )
    ).map((r) => [r.file, Number(r.n)]),
  );
  const u = group(usage.map((r) => ({ ...r, file: r.file! })));
  const c = group(calls);
  const b = group(cmds);
  const rd = group(reads);

  const readsOf = (file: string) => {
    const lastEdit = new Map<string, number>();
    const lastRead = new Map<string, number>();
    const out: { p: string; size: number; afterEdit: boolean }[] = [];
    (rd.get(file) ?? []).forEach((x, i) => {
      if (x.tool !== "read") return void lastEdit.set(x.p, i);
      const key = `${x.p}|${x.slice}`;
      const prev = lastRead.get(key);
      out.push({
        p: key,
        size: Number(x.size ?? 0),
        afterEdit: prev !== undefined && (lastEdit.get(x.p) ?? -1) > prev,
      });
      lastRead.set(key, i);
    });
    return out;
  };
  const cp = new Map(comps.map((r) => [r.file, Number(r.n)]));
  const cn = new Map(counts.map((r) => [r.file, r]));
  const st = group(stamps);
  const out: TailInput[] = [];
  for (const s of sessions) {
    const label = labelOf(s.file);
    const origin = originOf(s);
    if (!keep(label, origin)) continue;
    out.push({
      file: s.file,
      label,
      origin,
      usage: (u.get(s.file) ?? []).map((x) => ({
        file: s.file,
        model: x.model ?? "unknown",
        input: Number(x.input ?? 0),
        output: Number(x.output ?? 0),
        cacheRead: Number(x.cacheRead ?? 0),
        cacheWrite: Number(x.cacheWrite ?? 0),
        notional: Number(x.notional ?? 0),
      })),
      toolCalls: Object.fromEntries((c.get(s.file) ?? []).map((x) => [x.tool, Number(x.n)])),
      bashCommands: (b.get(s.file) ?? []).map((x) => x.command),
      ...(() => {
        const r = readsOf(s.file);
        return {
          readPaths: r.map((x) => x.p),
          readBytes: r.map((x) => x.size),
          readAfterEdit: r.map((x) => x.afterEdit),
        };
      })(),
      compactions: cp.get(s.file) ?? 0,
      userMessages: Number(cn.get(s.file)?.users ?? 0),
      aborts: Number(cn.get(s.file)?.aborts ?? 0),
      toolErrors: errs.get(s.file) ?? 0,
      retryLoops: loops.byFile.get(s.file) ?? 0,
      timestamps: (st.get(s.file) ?? []).map((x) => Number(x.ms)),
    });
  }
  return out;
}
