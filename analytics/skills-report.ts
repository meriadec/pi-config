/**
 * Skill usage audit: `bun analytics/skills-report.ts`.
 *
 * A session "invokes" a skill when it has at least one of:
 *  - `inject`: a user message with a text block that starts with `<skill name="X"` (this is what `/skill:X` and auto-load produce),
 *  - `read`: a `read` tool call on a path that ends with `X/SKILL.md`,
 *  - `command`: a user text that starts with `/skill:X` (raw, not expanded).
 * Each session counts once per skill. Outcome numbers are for the WHOLE invoking session (not only after the skill load).
 */
import { lstatSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSessions, rows } from "./db.ts";
import { costBySession, type MessageUsage } from "./cost.ts";

export type EventKind = "inject" | "read" | "command";
export interface SkillEvent {
  file: string;
  ts: string;
  skill: string;
  kind: EventKind;
  /** Text size of this load in bytes (injected text, or 0 when unknown for a read). */
  bytes: number;
}
export interface SessionStats {
  file: string;
  toolCalls: number;
  toolErrors: number;
  turns: number;
  cost?: number;
}

const INJECT = /^<skill name="([^"]+)"/;
const COMMAND = /^\s*\/skill:([\w.-]+)/;
const READ_PATH = /(?:^|\/)([^/]+)\/SKILL\.md$/;

/** Skill events in one user message. `content` is the message `content` JSON (string or block array). */
export function eventsFromUserContent(
  file: string,
  ts: string,
  content: string | unknown,
): SkillEvent[] {
  let blocks: unknown = content;
  if (typeof content === "string") {
    try {
      blocks = JSON.parse(content);
    } catch {
      blocks = [{ type: "text", text: content }];
    }
  }
  const texts: string[] = Array.isArray(blocks)
    ? blocks.flatMap((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? [(b as { text: string }).text]
          : [],
      )
    : typeof blocks === "string"
      ? [blocks]
      : [];
  const out: SkillEvent[] = [];
  for (const t of texts) {
    const inj = INJECT.exec(t);
    if (inj) out.push({ file, ts, skill: inj[1]!, kind: "inject", bytes: Buffer.byteLength(t) });
    else {
      const cmd = COMMAND.exec(t);
      if (cmd) out.push({ file, ts, skill: cmd[1]!, kind: "command", bytes: 0 });
    }
  }
  return out;
}

/** Skill event for a `read` tool call path, if it targets a SKILL.md. */
export function eventFromRead(file: string, ts: string, path: unknown): SkillEvent | undefined {
  if (typeof path !== "string") return undefined;
  const m = READ_PATH.exec(path);
  return m ? { file, ts, skill: m[1]!, kind: "read", bytes: 0 } : undefined;
}

export interface SkillAgg {
  skill: string;
  sessions: number;
  loads: number;
  first?: string;
  last?: string;
  recent: number;
  toolCalls: number;
  toolErrors: number;
  errorsPer1000: number;
  turns: number;
  cost: number;
  /** Tokens (bytes/4) put into context by all loads. */
  loadTokens: number;
}

/** Aggregate events and per-session stats per skill. `now` is injected for tests. */
export function aggregate(
  events: SkillEvent[],
  stats: Map<string, SessionStats>,
  sizeOf: (skill: string) => number,
  now: Date,
  recentDays = 60,
): Map<string, SkillAgg> {
  const cutoff = now.getTime() - recentDays * 86_400_000;
  const by = new Map<string, SkillEvent[]>();
  for (const e of events) (by.get(e.skill) ?? by.set(e.skill, []).get(e.skill)!).push(e);
  const out = new Map<string, SkillAgg>();
  for (const [skill, evs] of by) {
    const files = new Set(evs.map((e) => e.file));
    const ts = evs.map((e) => e.ts).sort();
    const recentFiles = new Set(
      evs.filter((e) => new Date(e.ts).getTime() >= cutoff).map((e) => e.file),
    );
    let toolCalls = 0,
      toolErrors = 0,
      turns = 0,
      cost = 0;
    for (const f of files) {
      const s = stats.get(f);
      if (!s) continue;
      toolCalls += s.toolCalls;
      toolErrors += s.toolErrors;
      turns += s.turns;
      cost += s.cost ?? 0;
    }
    // Loads: distinct (file, kind-agnostic) events; injected size when known, else the current file size.
    const loadBytes = evs
      .filter((e) => e.kind !== "command")
      .reduce((n, e) => n + (e.bytes || sizeOf(skill)), 0);
    out.set(skill, {
      skill,
      sessions: files.size,
      loads: evs.filter((e) => e.kind !== "command").length,
      first: ts[0],
      last: ts.at(-1),
      recent: recentFiles.size,
      toolCalls,
      toolErrors,
      errorsPer1000: toolCalls ? (toolErrors / toolCalls) * 1000 : 0,
      turns,
      cost,
      loadTokens: Math.round(loadBytes / 4),
    });
  }
  return out;
}

export interface SkillInfo {
  name: string;
  symlink: boolean;
  skillBytes: number;
  extraBytes: number;
  extraFiles: number;
  /** Symlink whose target has no SKILL.md. */
  broken?: boolean;
}

function walk(dir: string): { path: string; size: number }[] {
  const out: { path: string; size: number }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() || e.isSymbolicLink()) out.push({ path: p, size: statSync(p).size });
  }
  return out;
}

export function listSkills(dir: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const name of readdirSync(dir).sort()) {
    const root = join(dir, name);
    const symlink = lstatSync(root).isSymbolicLink();
    let hasSkill = false;
    try {
      hasSkill = statSync(join(root, "SKILL.md")).isFile();
    } catch {}
    if (!hasSkill) {
      if (symlink)
        out.push({ name, symlink, skillBytes: 0, extraBytes: 0, extraFiles: 0, broken: true });
      continue;
    }
    const files = walk(root);
    const mainPath = join(root, "SKILL.md");
    const extra = files.filter((f) => f.path !== mainPath);
    out.push({
      name,
      symlink,
      skillBytes: files.find((f) => f.path === mainPath)?.size ?? 0,
      extraBytes: extra.reduce((n, f) => n + f.size, 0),
      extraFiles: extra.length,
    });
  }
  return out;
}

export interface Row {
  info?: SkillInfo;
  name: string;
  agg?: SkillAgg;
}

/** One row per present skill plus one per skill seen in history but absent from the directory. */
export function buildRows(infos: SkillInfo[], aggs: Map<string, SkillAgg>): Row[] {
  const rowsOut: Row[] = infos.map((info) => ({ info, name: info.name, agg: aggs.get(info.name) }));
  const present = new Set(infos.map((i) => i.name));
  for (const [name, agg] of aggs) if (!present.has(name)) rowsOut.push({ name, agg });
  return rowsOut.sort(
    (a, b) => (b.agg?.sessions ?? 0) - (a.agg?.sessions ?? 0) || a.name.localeCompare(b.name),
  );
}

const day = (s?: string) => (s ? s.slice(0, 10) : "-");

export function formatRows(rs: Row[]): string {
  const head =
    "| skill | link | SKILL.md B | extra B (files) | sessions | loads | first | last | last 60d | tool calls | errors | err/1000 | turns | cost USD | load tokens | never used |";
  const sep = head.replace(/[^|]/g, "-");
  const lines = rs.map(({ info, name, agg }) => {
    const a = agg;
    return (
      "| " +
      [
        name + (info ? "" : " (not in agent/skills)"),
        info ? (info.broken ? "broken symlink" : info.symlink ? "symlink" : "local") : "-",
        info?.skillBytes ?? "-",
        info ? `${info.extraBytes} (${info.extraFiles})` : "-",
        a?.sessions ?? 0,
        a?.loads ?? 0,
        day(a?.first),
        day(a?.last),
        a?.recent ?? 0,
        a?.toolCalls ?? 0,
        a?.toolErrors ?? 0,
        a ? a.errorsPer1000.toFixed(1) : "-",
        a?.turns ?? 0,
        a ? a.cost.toFixed(2) : "-",
        a?.loadTokens ?? 0,
        a ? "" : "NEVER",
      ].join(" | ") +
      " |"
    );
  });
  return [head, sep, ...lines].join("\n");
}

/** Top `n` skills by tokens that all loads put into context. */
export const topByLoadTokens = (rs: Row[], n = 5) =>
  rs
    .filter((r) => r.agg)
    .sort((a, b) => b.agg!.loadTokens - a.agg!.loadTokens)
    .slice(0, n);

export const oversized = (rs: Row[], limit = 8192) =>
  rs.filter((r) => r.info && r.info.skillBytes > limit);

async function load() {
  const db = await openSessions();
  const events: SkillEvent[] = [];
  const users = await rows<{ file: string; ts: string; content: string }>(
    db,
    `select file, ts::varchar as ts, message->>'content' as content from messages
     where message->>'role' = 'user' and (message->>'content' like '%<skill name=%' or message->>'content' like '%/skill:%')`,
  );
  for (const u of users) events.push(...eventsFromUserContent(u.file, u.ts, u.content));
  const reads = await rows<{ file: string; ts: string; path: string }>(
    db,
    `select file, ts::varchar as ts, args->>'path' as path from tool_calls
     where tool = 'read' and args->>'path' like '%SKILL.md'`,
  );
  for (const r of reads) {
    const e = eventFromRead(r.file, r.ts, r.path);
    if (e) events.push(e);
  }
  const files = new Set(events.map((e) => e.file));
  const calls = await rows<{ file: string; n: string }>(
    db,
    `select file, count(*) as n from tool_calls group by file`,
  );
  const errs = await rows<{ file: string; n: string }>(
    db,
    `select file, count(*) as n from tool_results where is_error group by file`,
  );
  const turns = await rows<{ file: string; n: string }>(
    db,
    `select file, count(*) as n from messages where message->>'role' = 'assistant' group by file`,
  );
  const usage = await rows<MessageUsage>(
    db,
    `select file, message->>'model' as model,
       (message->'usage'->>'input')::double as input, (message->'usage'->>'output')::double as output,
       (message->'usage'->>'cacheRead')::double as cacheRead, (message->'usage'->>'cacheWrite')::double as cacheWrite,
       0 as notional
     from messages where message->>'role' = 'assistant' and (message->'usage') is not null`,
  );
  const costs = costBySession(usage.filter((u) => files.has(u.file)));
  const stats = new Map<string, SessionStats>();
  const s = (f: string) =>
    stats.get(f) ?? stats.set(f, { file: f, toolCalls: 0, toolErrors: 0, turns: 0 }).get(f)!;
  for (const c of calls) s(c.file).toolCalls = Number(c.n);
  for (const c of errs) s(c.file).toolErrors = Number(c.n);
  for (const c of turns) s(c.file).turns = Number(c.n);
  for (const [f, c] of costs) s(f).cost = c.cost;
  return { events, stats };
}

if (import.meta.main) {
  const dir = join(homedir(), ".pi/agent/skills");
  const infos = listSkills(dir);
  const { events, stats } = await load();
  const size = new Map(infos.map((i) => [i.name, i.skillBytes]));
  const aggs = aggregate(events, stats, (k) => size.get(k) ?? 0, new Date());
  const rs = buildRows(infos, aggs);
  console.log(formatRows(rs));
  console.log("\nTop 5 by load tokens:");
  for (const r of topByLoadTokens(rs))
    console.log(`- ${r.name}: ${r.agg!.loadTokens} tokens, ${r.agg!.loads} loads`);
  console.log("\nSKILL.md larger than 8 KB:");
  for (const r of oversized(rs)) console.log(`- ${r.name}: ${r.info!.skillBytes} B`);
}
