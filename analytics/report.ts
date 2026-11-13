#!/usr/bin/env bun
/**
 * Weekly report: `bun analytics/report.ts [--since YYYY-MM-DD]`.
 * Week = 7 days from --since (default: the last 7 days), compared with the 4 weeks before it.
 * No network: labels come from the LLM v2 cache; new sessions get rule labels (cap 300 per run).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { classifyFailure, TOOLING_CLASSES } from "./classify.ts";
import { openSessions, rows } from "./db.ts";
import { originOf } from "./label.ts";
import { loadCache } from "./llm-label.ts";
import { loadModelInputs } from "./models-data.ts";
import { sessionFeatures } from "./sessions.ts";
import { loadTailInputs } from "./tail-data.ts";
import {
  DAY_MS,
  renderWeekly,
  resolveLabels,
  split,
  windowsFrom,
  type RuleLabel,
  type WeeklySession,
} from "./weekly.ts";

export const RULE_CACHE = join(import.meta.dir, "data", "weekly-labels.jsonl");

export function loadRuleCache(file = RULE_CACHE) {
  const m = new Map<string, RuleLabel>();
  if (!existsSync(file)) return m;
  for (const line of readFileSync(file, "utf8").split("\n"))
    if (line) m.set((JSON.parse(line) as RuleLabel).file, JSON.parse(line) as RuleLabel);
  return m;
}

/** DuckDB gives "YYYY-MM-DD hh:mm:ss[.fff]" in UTC. */
export const parseStart = (s: string) =>
  Date.parse(`${s.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"}`);

export function parseSince(args: string[], now = new Date()): number {
  const i = args.indexOf("--since");
  if (i < 0) return now.getTime() - 7 * DAY_MS;
  const v = args[i + 1] ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)))
    throw new Error("--since needs YYYY-MM-DD");
  return Date.parse(`${v}T00:00:00Z`);
}

export async function buildWeekly(args: string[], now = new Date()) {
  const windows = windowsFrom(parseSince(args, now));
  const db = await openSessions();
  const all = (await sessionFeatures(db)).map((s) => ({
    ...s,
    startedMs: parseStart(s.startedAt),
  }));
  const inRange = all.filter(
    (s) => s.startedMs >= windows.prevStart && s.startedMs < windows.weekEnd,
  );
  const labels = resolveLabels(inRange, loadCache(), loadRuleCache());
  if (labels.added.length) {
    mkdirSync(dirname(RULE_CACHE), { recursive: true });
    appendFileSync(RULE_CACHE, labels.added.map((l) => `${JSON.stringify(l)}\n`).join(""));
  }
  const labelOf = (f: string) => labels.labelOf.get(f) ?? "UNLABELLED";
  const tail = await loadTailInputs(db, inRange, labelOf, originOf, () => true);
  const errs = new Map<string, Record<string, number>>();
  for (const e of await rows<{ file: string; tool: string; head: string; tail: string }>(
    db,
    "select file, tool, head, tail from tool_results where is_error",
  )) {
    const c = classifyFailure(e.tool, e.head, e.tail);
    if (!TOOLING_CLASSES.has(c)) continue;
    const r = errs.get(e.file) ?? {};
    r[c] = (r[c] ?? 0) + 1;
    errs.set(e.file, r);
  }
  const start = new Map(inRange.map((s) => [s.file, s.startedMs]));
  const sessions: WeeklySession[] = tail.map((t) => ({
    file: t.file,
    startedMs: start.get(t.file)!,
    label: t.label,
    usage: t.usage,
    toolingErrors: errs.get(t.file) ?? {},
    bashCommands: t.bashCommands,
  }));
  const weekFiles = new Set(split(sessions, windows).week.map((s) => s.file));
  const modelInputs = await loadModelInputs(
    db,
    inRange.filter((s) => weekFiles.has(s.file)),
    labelOf,
    originOf,
    () => true,
  );
  return renderWeekly({
    date: now.toISOString().slice(0, 10),
    windows,
    sessions,
    paths: new Map(inRange.map((s) => [s.file, s.file])),
    modelInputs,
    labelLine: labels.line,
  });
}

if (import.meta.main) {
  const now = new Date();
  const text = await buildWeekly(process.argv.slice(2), now);
  const dir = join(import.meta.dir, "data");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, `report-${now.toISOString().slice(0, 10)}.md`), text);
  console.log(text);
}
