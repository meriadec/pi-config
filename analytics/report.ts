#!/usr/bin/env bun
/** Weekly report: `bun analytics/report.ts [--days 7]`. Compares the last N days with the N days before. */
import type { DuckDBConnection } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { detectPolling } from "../agent/extensions/wait/polling.ts";
import { classifyFailure, TOOLING_CLASSES } from "./classify.ts";
import { openSessions, rows } from "./db.ts";

export interface PeriodStats {
  sessions: number;
  toolCalls: number;
  errors: number;
  toolingErrors: number;
  errorsByClass: Record<string, number>;
  bigResults: number; // single tool results over 20 KB
  resultMb: number;
  pollingCalls: number;
  waitForCalls: number;
}

const iso = (d: Date) => d.toISOString().replace("T", " ").replace("Z", "");

export async function collect(db: DuckDBConnection, from: Date, to: Date): Promise<PeriodStats> {
  const win = `ts >= timestamp '${iso(from)}' and ts < timestamp '${iso(to)}'`;
  const [totals] = await rows<{
    n: string;
    sessions: string;
    big: string;
    mb: string;
    errs: string;
  }>(
    db,
    `select count(*) n, count(distinct file) sessions,
       count(*) filter (where size > 20000) big, coalesce(sum(size), 0) / 1e6 mb,
       count(*) filter (where is_error) errs
     from tool_results where ${win}`,
  );
  const errs = await rows<{ tool: string; head: string; tail: string }>(
    db,
    `select tool, head, tail from tool_results where is_error and ${win}`,
  );
  const errorsByClass: Record<string, number> = {};
  let toolingErrors = 0;
  for (const e of errs) {
    const c = classifyFailure(e.tool, e.head, e.tail);
    errorsByClass[c] = (errorsByClass[c] ?? 0) + 1;
    if (TOOLING_CLASSES.has(c)) toolingErrors++;
  }
  const calls = await rows<{ name: string; cmd: string | null }>(
    db,
    `select json_extract_string(c, '$.name') as name, json_extract_string(c, '$.arguments.command') as cmd
     from (select unnest(from_json(message->'content', '["json"]')) as c
           from messages where message->>'role' = 'assistant' and json_type(message->'content') = 'ARRAY' and ${win})
     where json_extract_string(c, '$.type') = 'toolCall'`,
  );
  let pollingCalls = 0;
  let waitForCalls = 0;
  for (const c of calls) {
    if (c.name === "wait_for") waitForCalls++;
    if (c.name === "bash" && c.cmd && detectPolling(c.cmd)) pollingCalls++;
  }
  return {
    sessions: Number(totals?.sessions ?? 0),
    toolCalls: calls.length,
    errors: errs.length,
    toolingErrors,
    errorsByClass,
    bigResults: Number(totals?.big ?? 0),
    resultMb: Math.round(Number(totals?.mb ?? 0)),
    pollingCalls,
    waitForCalls,
  };
}

const per1k = (n: number, total: number) => (total === 0 ? "0.0" : ((1000 * n) / total).toFixed(1));
const delta = (now: number, before: number) => {
  if (before === 0) return now === 0 ? "=" : "new";
  const d = Math.round((100 * (now - before)) / before);
  return d === 0 ? "=" : `${d > 0 ? "+" : ""}${d}%`;
};

export function renderReport(
  cur: PeriodStats,
  prev: PeriodStats,
  days: number,
  today: string,
): string {
  const row = (label: string, a: string | number, b: string | number, d: string) =>
    `| ${label} | ${a} | ${b} | ${d} |`;
  const classes = Object.entries(cur.errorsByClass)
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
    .map(([k, v]) => `- ${k}: ${v} (before: ${prev.errorsByClass[k] ?? 0})`);
  return [
    `# Pi weekly report ${today} (last ${days} days vs the ${days} before)`,
    "",
    "| Metric | Now | Before | Change |",
    "|---|---|---|---|",
    row("Sessions with tool use", cur.sessions, prev.sessions, delta(cur.sessions, prev.sessions)),
    row("Tool calls", cur.toolCalls, prev.toolCalls, delta(cur.toolCalls, prev.toolCalls)),
    row(
      "Errors per 1000 calls",
      per1k(cur.errors, cur.toolCalls),
      per1k(prev.errors, prev.toolCalls),
      "",
    ),
    row(
      "Tooling errors per 1000 calls",
      per1k(cur.toolingErrors, cur.toolCalls),
      per1k(prev.toolingErrors, prev.toolCalls),
      "",
    ),
    row(
      "Results over 20 KB",
      cur.bigResults,
      prev.bigResults,
      delta(cur.bigResults, prev.bigResults),
    ),
    row("Tool result volume (MB)", cur.resultMb, prev.resultMb, delta(cur.resultMb, prev.resultMb)),
    row(
      "Hand-made polling commands",
      cur.pollingCalls,
      prev.pollingCalls,
      delta(cur.pollingCalls, prev.pollingCalls),
    ),
    row(
      "wait_for calls",
      cur.waitForCalls,
      prev.waitForCalls,
      delta(cur.waitForCalls, prev.waitForCalls),
    ),
    "",
    "## Top error classes",
    ...(classes.length ? classes : ["- none"]),
    "",
  ].join("\n");
}

if (import.meta.main) {
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Number(process.argv[i + 1]) : 7;
  if (!(days > 0)) throw new Error("--days must be a positive number");
  const now = new Date();
  const mid = new Date(now.getTime() - days * 86_400_000);
  const start = new Date(mid.getTime() - days * 86_400_000);
  const db = await openSessions();
  const text = renderReport(
    await collect(db, mid, now),
    await collect(db, start, mid),
    days,
    now.toISOString().slice(0, 10),
  );
  const dir = join(import.meta.dir, "data");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, `report-${now.toISOString().slice(0, 10)}.md`), text);
  console.log(text);
}
