#!/usr/bin/env bun
import { labelByRules, originOf } from "./label.ts";
import { labelWithLlm, loadCache } from "./llm-label.ts";
import { sessionFeatures } from "./sessions.ts";
import { classifyFailure, TOOLING_CLASSES } from "./classify.ts";
import {
  avoidableRereads,
  avoidableRereadBytesByFile,
  avoidableRereadsSameSlice,
  repeatedReads,
  retryLoops,
} from "./reports.ts";
import { detectPolling } from "../agent/extensions/wait/polling.ts";
import { buildProfile, formatProfile, type SessionProfileInput } from "./profile.ts";
import { openSessions, rows } from "./db.ts";

const [cmd = "help"] = process.argv.slice(2);
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;

async function errors() {
  const db = await openSessions();
  const [{ n }] = await rows<{ n: string }>(db, "select count(*) n from tool_results");
  const errs = await rows<{ tool: string; head: string; tail: string }>(
    db,
    "select tool, head, tail from tool_results where is_error",
  );
  const byClass = new Map<string, number>();
  const byToolClass = new Map<string, number>();
  let tooling = 0;
  for (const e of errs) {
    const c = classifyFailure(e.tool, e.head, e.tail);
    byClass.set(c, (byClass.get(c) ?? 0) + 1);
    byToolClass.set(`${e.tool}:${c}`, (byToolClass.get(`${e.tool}:${c}`) ?? 0) + 1);
    if (TOOLING_CLASSES.has(c)) tooling++;
  }
  console.log(
    `tool results: ${n}, errors: ${errs.length} (${pct(errs.length, Number(n))}), tooling-caused: ${tooling}`,
  );
  console.log("\nby class");
  for (const [k, v] of [...byClass].sort((a, b) => b[1] - a[1]))
    console.log(String(v).padStart(7), k);
  console.log("\ntop tool:class");
  for (const [k, v] of [...byToolClass].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(String(v).padStart(7), k);
  }
}

async function context() {
  const db = await openSessions();
  for (const r of await rows(
    db,
    `select tool, count(*) calls, round(sum(size)/1e6) mb, round(avg(size)) avg_bytes,
       count(*) filter (where size > 20000) over_20k, count(*) filter (where size > 100000) over_100k
     from tool_results group by 1 order by sum(size) desc limit 8`,
  )) {
    console.log(JSON.stringify(r));
  }
}

/** How often models poll by hand. Validates the wait-guard rules against real history. */
async function polling() {
  const db = await openSessions();
  const cmds = await rows<{ file: string; cmd: string }>(
    db,
    `select file, json_extract_string(c, '$.arguments.command') as cmd
     from (select file, unnest(from_json(message->'content', '["json"]')) as c
           from messages where message->>'role' = 'assistant' and json_type(message->'content') = 'ARRAY')
     where json_extract_string(c, '$.name') = 'bash'`,
  );
  const byKind = new Map<string, number>();
  const sessions = new Set<string>();
  const samples = new Map<string, string>();
  for (const { file, cmd } of cmds) {
    const kind = cmd ? detectPolling(cmd) : undefined;
    if (!kind) continue;
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    sessions.add(file);
    if (!samples.has(kind)) samples.set(kind, cmd.slice(0, 120).replaceAll("\n", " "));
  }
  console.log(
    `bash calls: ${cmds.length}, polling-like: ${[...byKind.values()].reduce((a, b) => a + b, 0)}, sessions: ${sessions.size}`,
  );
  for (const [k, v] of [...byKind].sort((a, b) => b[1] - a[1]))
    console.log(String(v).padStart(6), k, "|", samples.get(k));
}

async function loops() {
  const { total, byKey } = await retryLoops(await openSessions());
  console.log(`retry loops (3+ same failure in a row): ${total}`);
  for (const [k, v] of byKey.slice(0, 12)) console.log(String(v).padStart(6), k);
}

async function reads() {
  const db = await openSessions();
  console.log(await repeatedReads(db));
  console.log("avoidable, any slice:", await avoidableRereads(db));
  const { total, top } = await avoidableRereadsSameSlice(db);
  console.log("avoidable, same slice:", total);
  for (const r of top) console.log(JSON.stringify(r));
}

async function labels() {
  const args = process.argv.slice(3);
  const limit = Number(args[args.indexOf("--limit") + 1]) || undefined;
  const all = await sessionFeatures(await openSessions());
  const decided = all.map((s) => ({ s, r: labelByRules(s) }));
  const unclear = decided.filter((d) => d.r.label === null).map((d) => d.s);
  if (args.includes("--llm")) {
    const { asked, partialOrFailedBatches } = await labelWithLlm(unclear, { limit });
    console.log(`llm asked: ${asked}, partial or failed batches: ${partialOrFailedBatches}`);
  }
  const cache = loadCache();
  const counts = new Map<string, number>();
  const origins = new Map<string, number>();
  for (const { s, r } of decided) {
    const label = r.label ?? cache.get(s.file)?.label ?? "UNLABELLED";
    const key = `${label}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const o = originOf(s);
    origins.set(o, (origins.get(o) ?? 0) + 1);
  }
  console.log(`sessions: ${all.length}, rules decided: ${all.length - unclear.length}`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(String(v).padStart(6), k);
  console.log("origin:", Object.fromEntries(origins));
}

async function profile() {
  const db = await openSessions();
  const sessions = await sessionFeatures(db);
  const cache = loadCache();
  const num = async (sql: string) =>
    new Map((await rows<{ file: string; n: string }>(db, sql)).map((r) => [r.file, Number(r.n)]));
  const [turns, calls, delegates, results, readBytes, rereads, loopStats] = await Promise.all([
    num("select file, count(*) n from messages where message->>'role' = 'assistant' group by 1"),
    num("select file, count(*) n from tool_calls group by 1"),
    num("select file, count(*) n from tool_calls where tool like '%delegate_task' group by 1"),
    num("select file, count(*) n from tool_results group by 1"),
    num(
      "select c.file, sum(r.size) n from tool_calls c join tool_results r using (call_id) where c.tool = 'read' group by 1",
    ),
    avoidableRereadBytesByFile(db),
    retryLoops(db),
  ]);
  const errs = new Map<string, { e: number; t: number }>();
  for (const r of await rows<{ file: string; tool: string; head: string; tail: string }>(
    db,
    "select file, tool, head, tail from tool_results where is_error",
  )) {
    const x = errs.get(r.file) ?? { e: 0, t: 0 };
    x.e++;
    if (TOOLING_CLASSES.has(classifyFailure(r.tool, r.head, r.tail))) x.t++;
    errs.set(r.file, x);
  }
  const input: SessionProfileInput[] = sessions.map((s) => ({
    label: labelByRules(s).label ?? cache.get(s.file)?.label ?? "UNLABELLED",
    origin: originOf(s),
    assistantTurns: turns.get(s.file) ?? 0,
    toolCalls: calls.get(s.file) ?? 0,
    toolResults: results.get(s.file) ?? 0,
    errors: errs.get(s.file)?.e ?? 0,
    toolingErrors: errs.get(s.file)?.t ?? 0,
    readBytes: readBytes.get(s.file) ?? 0,
    rereadBytes: rereads.get(s.file) ?? 0,
    retryLoops: loopStats.byFile.get(s.file) ?? 0,
    delegateCalls: delegates.get(s.file) ?? 0,
  }));
  const table = buildProfile(input);
  console.log(
    process.argv.includes("--json") ? JSON.stringify(table, null, 2) : formatProfile(table),
  );
}

const commands: Record<string, () => Promise<void>> = {
  labels,
  errors,
  context,
  polling,
  loops,
  reads,
  profile,
};
if (commands[cmd]) await commands[cmd]();
else console.log("usage: bun analytics/cli.ts <labels|errors|context|polling|loops|reads|profile>");
