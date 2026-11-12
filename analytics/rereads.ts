import type { DuckDBConnection } from "@duckdb/node-api";
import { rows } from "./db.ts";

export type RereadEvent =
  | {
      kind: "read";
      file: string;
      ts: number;
      turn: number;
      path: string;
      slice: string;
      size: number;
    }
  | { kind: "write"; file: string; ts: number; path: string }
  | { kind: "bash"; file: string; ts: number; command: string }
  | { kind: "compaction"; file: string; ts: number };

export const CAUSES = ["image", "after_compaction", "small", "repo_docs", "near", "far"] as const;
export type Cause = (typeof CAUSES)[number];

export const STUB_BYTES = 80;
export const SMALL_BYTES = 2048;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
const DOC_RE =
  /(^|\/)(README|AGENTS|CLAUDE|CONTRIBUTING|CHANGELOG|SKILL)[^/]*\.md$|(^|\/)docs?\/.*\.mdx?$|\.mdx?$/i;
/** Bash that may write a file. A path-agnostic heuristic: the logs do not show which file changed. */
const BASH_WRITE_RE =
  /(^|[^<>=!-])>>?\s*[^&\s]|\bsed\s+(-[a-z]*i|--in-place)|\btee\b|\b(mv|cp|rm|touch|patch)\s|\bgit\s+(checkout|stash|pull|rebase|reset|apply|merge|restore|switch|cherry-pick)\b|--fix\b|--write\b|\bprettier\b|\bformat\b/;

export const isImagePath = (p: string) => IMAGE_RE.test(p);
export const isRepoDoc = (p: string) => DOC_RE.test(p);
export const bashMayWrite = (c: string) => BASH_WRITE_RE.test(c);

export interface Reread {
  file: string;
  path: string;
  size: number;
  cause: Cause;
  gapTurns: number;
  /** A bash command that may write ran between the two reads. */
  bashRisk: boolean;
}

export interface RereadOptions {
  /** Max turns between reads for the "near" cause. */
  nearTurns?: number;
}

/** Find avoidable same-slice re-reads (no edit/write of the path in between) and tag each with one cause. */
export function findRereads(events: RereadEvent[], opts: RereadOptions = {}): Reread[] {
  const near = opts.nearTurns ?? 20;
  const byFile = new Map<string, RereadEvent[]>();
  for (const e of events) {
    const l = byFile.get(e.file) ?? [];
    l.push(e);
    byFile.set(e.file, l);
  }
  const out: Reread[] = [];
  for (const [file, list] of byFile) {
    list.sort((a, b) => a.ts - b.ts);
    const last = new Map<string, Extract<RereadEvent, { kind: "read" }>>();
    for (const e of list) {
      if (e.kind !== "read") continue;
      const key = `${e.path}\0${e.slice}`;
      const prev = last.get(key);
      last.set(key, e);
      if (!prev) continue;
      const between = list.filter((x) => x.ts > prev.ts && x.ts <= e.ts);
      if (between.some((x) => x.kind === "write" && x.path === e.path)) continue;
      const compacted = between.some((x) => x.kind === "compaction");
      const bashRisk = between.some((x) => x.kind === "bash" && bashMayWrite(x.command));
      const gapTurns = e.turn - prev.turn;
      const cause: Cause = isImagePath(e.path)
        ? "image"
        : compacted
          ? "after_compaction"
          : e.size < SMALL_BYTES
            ? "small"
            : isRepoDoc(e.path)
              ? "repo_docs"
              : gapTurns <= near
                ? "near"
                : "far";
      out.push({ file, path: e.path, size: e.size, cause, gapTurns, bashRisk });
    }
  }
  return out;
}

export interface RereadSummary {
  totalReadBytes: number;
  total: { count: number; bytes: number };
  byCause: Record<Cause, { count: number; bytes: number }>;
  /** Stub replaces the result: text only, no compaction between, stub shorter than content. */
  saved: { count: number; bytes: number };
  /** Same, but skipping re-reads where a bash command that may write ran in between. */
  savedNoBashRisk: { count: number; bytes: number };
}

export function summarizeRereads(
  rereads: Reread[],
  totalReadBytes: number,
  stubBytes = STUB_BYTES,
): RereadSummary {
  const byCause = Object.fromEntries(
    CAUSES.map((c) => [c, { count: 0, bytes: 0 }]),
  ) as RereadSummary["byCause"];
  const saved = { count: 0, bytes: 0 };
  const savedNoBashRisk = { count: 0, bytes: 0 };
  let count = 0;
  let bytes = 0;
  for (const r of rereads) {
    count++;
    bytes += r.size;
    byCause[r.cause].count++;
    byCause[r.cause].bytes += r.size;
    if (r.cause === "image" || r.cause === "after_compaction" || r.size <= stubBytes) continue;
    saved.count++;
    saved.bytes += r.size - stubBytes;
    if (r.bashRisk) continue;
    savedNoBashRisk.count++;
    savedNoBashRisk.bytes += r.size - stubBytes;
  }
  return { totalReadBytes, total: { count, bytes }, byCause, saved, savedNoBashRisk };
}

const mb = (n: number) => (n / 1e6).toFixed(1);
const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";

export function formatRereads(s: RereadSummary, nearTurns = 20): string {
  const lines = [
    `read bytes: ${mb(s.totalReadBytes)} MB; avoidable same-slice re-reads: ${s.total.count} (${mb(s.total.bytes)} MB, ${pct(s.total.bytes, s.totalReadBytes)})`,
    `by cause (first match wins; near = within ${nearTurns} turns):`,
  ];
  for (const c of CAUSES)
    lines.push(
      `  ${c.padEnd(17)} ${String(s.byCause[c].count).padStart(6)}  ${mb(s.byCause[c].bytes).padStart(7)} MB  ${pct(s.byCause[c].bytes, s.total.bytes)}`,
    );
  lines.push(
    `simulated stub savings (text, no compaction between): ${s.saved.count} reads, ${mb(s.saved.bytes)} MB = ${pct(s.saved.bytes, s.totalReadBytes)} of read bytes`,
    `  without reads where bash may have written: ${s.savedNoBashRisk.count} reads, ${mb(s.savedNoBashRisk.bytes)} MB = ${pct(s.savedNoBashRisk.bytes, s.totalReadBytes)}`,
    "blind spot: logs have no mtime/hash. A bash write is not tracked, so the first figure is an upper bound; the real extension checks mtime and size.",
  );
  return lines.join("\n");
}

/** DuckDB prints timestamps without a zone ("2026-11-11 15:18:51.129", UTC); raw JSONL has "T...Z". Treat both as UTC. */
export function parseTs(s: string): number {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(/Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`).getTime();
}

export async function loadRereadEvents(
  db: DuckDBConnection,
): Promise<{ events: RereadEvent[]; totalReadBytes: number }> {
  const t = parseTs;
  const events: RereadEvent[] = [];
  const asst = await rows<{ file: string; ts: string }>(
    db,
    "select file, ts from messages where message->>'role' = 'assistant' order by file, ts",
  );
  const turns = new Map<string, number[]>();
  for (const a of asst) {
    const l = turns.get(a.file) ?? [];
    l.push(t(a.ts));
    turns.set(a.file, l);
  }
  const turnAt = (file: string, ts: number) => {
    const l = turns.get(file) ?? [];
    let lo = 0;
    let hi = l.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (l[m]! <= ts) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const reads = await rows<{
    file: string;
    ts: string;
    p: string;
    slice: string;
    size: string;
  }>(
    db,
    `select c.file, c.ts, c.args->>'path' as p,
       coalesce(c.args->>'offset', '') || ':' || coalesce(c.args->>'limit', '') as slice, r.size
     from tool_calls c join tool_results r using (call_id) where c.tool = 'read' and c.args->>'path' is not null`,
  );
  let totalReadBytes = 0;
  for (const r of reads) {
    const ts = t(r.ts);
    totalReadBytes += Number(r.size);
    events.push({
      kind: "read",
      file: r.file,
      ts,
      turn: turnAt(r.file, ts),
      path: r.p,
      slice: r.slice,
      size: Number(r.size),
    });
  }
  for (const w of await rows<{ file: string; ts: string; p: string }>(
    db,
    "select file, ts, args->>'path' as p from tool_calls where tool in ('edit','write') and args->>'path' is not null",
  ))
    events.push({ kind: "write", file: w.file, ts: t(w.ts), path: w.p });
  for (const b of await rows<{ file: string; ts: string; command: string }>(
    db,
    "select file, ts, command from tool_calls where tool = 'bash' and command is not null",
  ))
    events.push({ kind: "bash", file: b.file, ts: t(b.ts), command: b.command });
  return { events, totalReadBytes };
}

/** Compaction entries are not in the `messages` table, so read them from the raw JSONL. */
export async function loadCompactions(db: DuckDBConnection, glob: string): Promise<RereadEvent[]> {
  const src = glob.replaceAll("'", "''");
  const res = await rows<{ file: string; ts: string }>(
    db,
    `select filename as file, timestamp as ts
     from read_json('${src}', format='newline_delimited',
       columns={type:'VARCHAR', timestamp:'VARCHAR'}, filename=true, ignore_errors=true,
       maximum_object_size=268435456)
     where type = 'compaction'`,
  );
  return res.map((r) => ({ kind: "compaction", file: r.file, ts: parseTs(r.ts) }));
}
