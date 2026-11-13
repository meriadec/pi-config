#!/usr/bin/env bun
import { originOf } from "./label.ts";
import { labelWithLlm, loadCache, PROMPT_VERSION } from "./llm-label.ts";
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
import { buildProfile, formatProfile, labelFor, type SessionProfileInput } from "./profile.ts";
import { openSessions, rows, SESSIONS_GLOB } from "./db.ts";
import {
  findRereads,
  formatRereads,
  loadCompactions,
  loadRereadEvents,
  summarizeRereads,
} from "./rereads.ts";
import { costBySession, summarizeCost, type MessageUsage } from "./cost.ts";
import { PRICE_TABLE_VERSION } from "./prices.ts";
import { analyzeImages, formatImages, scanSession, type SessionImages } from "./images.ts";
import { formatImpact, scanOutcome } from "./images-impact.ts";
import { readFileSync } from "node:fs";
import { loadTailInputs } from "./tail-data.ts";
import { buildTail, formatInterventions, formatTail, interventions, sessionTail } from "./tail.ts";
import { loadModelInputs } from "./models-data.ts";
import { buildReport, formatReport, keywordSample } from "./models.ts";
import { runCompare, runRefresh, runSample, runScore } from "./validate.ts";

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

async function rereads() {
  const db = await openSessions();
  const i = process.argv.indexOf("--near");
  const near = i >= 0 ? Number(process.argv[i + 1]) : 20;
  const { events, totalReadBytes } = await loadRereadEvents(db);
  events.push(...(await loadCompactions(db, SESSIONS_GLOB)));
  const found = findRereads(events, { nearTurns: near });
  console.log(formatRereads(summarizeRereads(found, totalReadBytes), near));
}

async function labels() {
  const args = process.argv.slice(3);
  const limit = Number(args[args.indexOf("--limit") + 1]) || undefined;
  const all = await sessionFeatures(await openSessions());
  if (args.includes("--llm")) {
    const { asked, partialOrFailedBatches } = await labelWithLlm(all, {
      limit,
    });
    console.log(`llm asked: ${asked}, partial or failed batches: ${partialOrFailedBatches}`);
  }
  const cache = loadCache();
  const counts = new Map<string, number>();
  const origins = new Map<string, number>();
  for (const s of all) {
    const label = cache.get(s.file)?.label ?? "UNLABELLED";
    counts.set(label, (counts.get(label) ?? 0) + 1);
    const o = originOf(s);
    origins.set(o, (origins.get(o) ?? 0) + 1);
  }
  console.log(`sessions: ${all.length}, llm labelled: ${cache.size} (prompt ${PROMPT_VERSION})`);
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]))
    console.log(String(v).padStart(6), k);
  console.log("origin:", Object.fromEntries(origins));
}

async function usageRows(db: Awaited<ReturnType<typeof openSessions>>): Promise<MessageUsage[]> {
  const r = await rows<Record<string, string | null>>(
    db,
    `select file, message->>'model' as model,
       (message->'usage'->>'input')::double as input, (message->'usage'->>'output')::double as output,
       (message->'usage'->>'cacheRead')::double as cacheRead, (message->'usage'->>'cacheWrite')::double as cacheWrite,
       coalesce((message->'usage'->'cost'->>'total')::double, 0) as notional
     from messages where message->>'role' = 'assistant' and (message->'usage') is not null`,
  );
  return r.map((x) => ({
    file: x.file!,
    model: x.model ?? "unknown",
    input: Number(x.input ?? 0),
    output: Number(x.output ?? 0),
    cacheRead: Number(x.cacheRead ?? 0),
    cacheWrite: Number(x.cacheWrite ?? 0),
    notional: Number(x.notional ?? 0),
  }));
}

async function cost() {
  const s = summarizeCost(await usageRows(await openSessions()));
  const usd = (x: number) => `$${x.toFixed(2)}`;
  console.log(
    `prices: ${PRICE_TABLE_VERSION} + prices.override.json (USD per 1M tokens, public API)`,
  );
  console.log(`recomputed cost (priced models only): ${usd(s.total)}`);
  console.log(
    `tokens: ${s.tokens}, unpriced: ${s.unpricedTokens} (${pct(s.unpricedTokens, s.tokens)})`,
  );
  const unpriced = s.byModel.filter((m) => !m.priced);
  if (unpriced.length) console.log("\nUNPRICED models (cost missing, not zero)");
  for (const m of unpriced) console.log(String(m.tokens).padStart(14), m.model);
  console.log("\ncost by model");
  console.log(["model", "msgs", "tokens", "recomputed", "notional", "ratio"].join("\t"));
  for (const m of s.byModel.filter((x) => x.priced))
    console.log(
      [
        m.model,
        m.messages,
        m.tokens,
        usd(m.cost),
        usd(m.notional),
        m.ratio?.toFixed(2) ?? "n/a",
      ].join("\t"),
    );
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
  const costs = costBySession(await usageRows(db));
  const errs = new Map<string, { e: number; t: number }>();
  for (const r of await rows<{
    file: string;
    tool: string;
    head: string;
    tail: string;
  }>(db, "select file, tool, head, tail from tool_results where is_error")) {
    const x = errs.get(r.file) ?? { e: 0, t: 0 };
    x.e++;
    if (TOOLING_CLASSES.has(classifyFailure(r.tool, r.head, r.tail))) x.t++;
    errs.set(r.file, x);
  }
  const input: SessionProfileInput[] = sessions.map((s) => ({
    label: labelFor(cache, s.file),
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
    cost: costs.get(s.file)?.cost ?? 0,
    unpricedTokens: costs.get(s.file)?.unpricedTokens ?? 0,
  }));
  const table = buildProfile(input);
  console.log(
    process.argv.includes("--json") ? JSON.stringify(table, null, 2) : formatProfile(table),
  );
}

async function tail() {
  const a = process.argv.slice(3);
  const opt = (n: string, d: string) => (a.includes(n) ? a[a.indexOf(n) + 1]! : d);
  const label = opt("--label", "implement");
  const db = await openSessions();
  const cache = loadCache();
  const inputs = await loadTailInputs(
    db,
    await sessionFeatures(db),
    (f) => labelFor(cache, f),
    originOf,
    (l, o) => l === label && o === "human",
  );
  const report = buildTail(inputs.map(sessionTail), { top: Number(opt("--top", "5")) });
  console.log(formatTail(report, `${label} (human)`));
  console.log(formatInterventions(interventions(inputs)));
}

async function models() {
  const a = process.argv.slice(3);
  const label = a.includes("--label") ? a[a.indexOf("--label") + 1] : undefined;
  const db = await openSessions();
  const cache = loadCache();
  const inputs = await loadModelInputs(
    db,
    await sessionFeatures(db),
    (f) => labelFor(cache, f),
    originOf,
    (l) => !label || l === label,
  );
  console.log(formatReport(buildReport(inputs)));
  console.log("\nKeyword hand-check sample (path | snippet):");
  for (const s of keywordSample(inputs)) console.log(`${s.file} | ${s.snippet}`);
}

async function validate() {
  const [, , , sub, ...rest] = process.argv;
  const flag = (name: string, d: number) => {
    const i = rest.indexOf(name);
    return i >= 0 ? Number(rest[i + 1]) : d;
  };
  if (sub === "sample") {
    const items = await runSample(
      await sessionFeatures(await openSessions()),
      flag("--n", 100),
      flag("--seed", 1),
    );
    console.log(`sample: ${items.length} items -> analytics/data/validation/sample.md`);
  } else if (sub === "score" && rest[0]) console.log(runScore(rest[0]));
  else if (sub === "refresh")
    console.log(await runRefresh(await sessionFeatures(await openSessions())));
  else if (sub === "compare" && rest[0])
    console.log(await runCompare(await sessionFeatures(await openSessions()), rest[0]));
  else
    console.log(
      "usage: validate sample [--n 100] [--seed 1] | validate refresh | validate score <answers-file> | validate compare <answers-file>",
    );
}

async function images() {
  const sessions = await sessionFeatures(await openSessions());
  const cache = loadCache();
  const labels = new Map(sessions.map((s) => [s.file, cache.get(s.file)?.label ?? "UNLABELLED"]));
  if (process.argv.includes("--impact")) {
    const dir = SESSIONS_GLOB.replace(/\/\*\/\*\.jsonl$/, "");
    const out = [...new Bun.Glob("*/*.jsonl").scanSync({ cwd: dir, absolute: true })].map((f) =>
      scanOutcome(f, readFileSync(f, "utf8").split("\n").filter(Boolean)),
    );
    console.log(formatImpact(out, (f) => labels.get(f) ?? "UNLABELLED"));
    return;
  }
  const scanned: SessionImages[] = [];
  for (const f of new Bun.Glob("*/*.jsonl").scanSync({
    cwd: SESSIONS_GLOB.replace(/\/\*\/\*\.jsonl$/, ""),
    absolute: true,
  }))
    scanned.push(scanSession(f, readFileSync(f, "utf8").split("\n").filter(Boolean)));
  console.log(formatImages(analyzeImages(scanned, (f) => labels.get(f) ?? "UNLABELLED")));
}

const commands: Record<string, () => Promise<void>> = {
  labels,
  errors,
  context,
  polling,
  loops,
  reads,
  rereads,
  profile,
  cost,
  validate,
  images,
  tail,
  models,
};
if (commands[cmd]) await commands[cmd]();
else
  console.log(
    "usage: bun analytics/cli.ts <labels|errors|context|polling|loops|reads|rereads|profile|cost|validate|images|tail|models>",
  );
