#!/usr/bin/env bun
import { classifyFailure, TOOLING_CLASSES } from "./classify.ts";
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

const commands: Record<string, () => Promise<void>> = { errors, context };
if (commands[cmd]) await commands[cmd]();
else console.log("usage: bun analytics/cli.ts <errors|context>");
