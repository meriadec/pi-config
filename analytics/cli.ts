#!/usr/bin/env bun
import { classifyFailure, TOOLING_CLASSES } from "./classify.ts";
import { detectPolling } from "../agent/extensions/wait/polling.ts";
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

const commands: Record<string, () => Promise<void>> = { errors, context, polling };
if (commands[cmd]) await commands[cmd]();
else console.log("usage: bun analytics/cli.ts <errors|context|polling>");
