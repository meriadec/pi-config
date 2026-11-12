import type { DuckDBConnection } from "@duckdb/node-api";
import { classifyFailure } from "./classify.ts";
import { rows } from "./db.ts";

/** Same tool failing 3+ times in a row inside one session. */
export async function retryLoops(db: DuckDBConnection) {
  const res = await rows<{
    file: string;
    tool: string;
    is_error: boolean;
    head: string;
    tail: string;
  }>(db, "select file, tool, is_error, head, tail from tool_results order by file, ts");
  const runs = new Map<string, number>();
  let total = 0;
  let cur = { file: "", key: "", n: 0 };
  const flush = () => {
    if (cur.n < 3) return;
    runs.set(cur.key, (runs.get(cur.key) ?? 0) + 1);
    total++;
  };
  for (const r of res) {
    const key = r.is_error ? `${r.tool}:${classifyFailure(r.tool, r.head, r.tail)}` : "";
    if (key && key === cur.key && r.file === cur.file) cur.n++;
    else {
      flush();
      cur = { file: r.file, key, n: key ? 1 : 0 };
    }
  }
  flush();
  return { total, byKey: [...runs].sort((a, b) => b[1] - a[1]) };
}

/** Repeated reads of the same path in one session, and the bytes they cost. */
export async function repeatedReads(db: DuckDBConnection) {
  return rows(
    db,
    `with x as (
       select c.file, c.args->>'path' as p, count(*) as n, sum(r.size) as bytes
       from tool_calls c join tool_results r using (call_id)
       where c.tool = 'read' group by 1, 2)
     select count(*) as distinct_session_files,
       count(*) filter (where n > 1) as read_more_than_once,
       sum(n - 1) as extra_reads,
       round(sum(bytes * (n - 1) / n) / 1e6) as approx_repeat_mb,
       round(sum(bytes) / 1e6) as total_mb
     from x`,
  );
}

/** Re-reads with no edit or write of that path in between: pure waste, the agent already had the content. */
export async function avoidableRereads(db: DuckDBConnection) {
  return rows(
    db,
    `with r as (
       select c.file, c.ts, c.args->>'path' as p, rr.size,
         lag(c.ts) over (partition by c.file, c.args->>'path' order by c.ts) as prev_ts
       from tool_calls c join tool_results rr using (call_id) where c.tool = 'read'),
     w as (select file, args->>'path' as p, ts from tool_calls where tool in ('edit', 'write'))
     select count(*) as rereads, round(sum(size) / 1e6) as mb
     from r where prev_ts is not null
       and not exists (select 1 from w where w.file = r.file and w.p = r.p and w.ts > r.prev_ts and w.ts <= r.ts)`,
  );
}

/** Same as avoidableRereads but the slice (offset, limit) must match, so partial reads of big files do not count. */
export async function avoidableRereadsSameSlice(db: DuckDBConnection) {
  const base = `with r as (
       select c.file, c.ts, c.args->>'path' as p,
         coalesce(c.args->>'offset', '') || ':' || coalesce(c.args->>'limit', '') as slice, rr.size,
         lag(c.ts) over (partition by c.file, c.args->>'path',
           coalesce(c.args->>'offset', '') || ':' || coalesce(c.args->>'limit', '') order by c.ts) as prev_ts
       from tool_calls c join tool_results rr using (call_id) where c.tool = 'read'),
     w as (select file, args->>'path' as p, ts from tool_calls where tool in ('edit', 'write')),
     a as (select * from r where prev_ts is not null
       and not exists (select 1 from w where w.file = r.file and w.p = r.p and w.ts > r.prev_ts and w.ts <= r.ts))`;
  const total = await rows(
    db,
    `${base} select count(*) as rereads, round(sum(size) / 1e6) as mb from a`,
  );
  const top = await rows(
    db,
    `${base} select regexp_replace(p, '^.*/(.*/.*)$', '\\1') as path, count(*) as rereads,
       count(distinct file) as sessions, round(sum(size) / 1e6, 1) as mb
     from a group by p order by sum(size) desc limit 15`,
  );
  return { total, top };
}
