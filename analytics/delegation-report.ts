import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyError,
  describeCall,
  parseResult,
  sha1,
  shortName,
} from "../agent/extensions/delegation-guard/rules.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIVE_LOG = resolve(HERE, "data/delegation.jsonl");
export const SESSIONS_DIR = join(homedir(), ".pi/agent/sessions");

/** One delegated child, from history or from the live log. */
export interface CallRec {
  session: string;
  tool: string;
  role?: string | undefined;
  mode?: string | undefined;
  model?: string | undefined;
  taskSha1: string;
  /** undefined: no result seen. */
  ok?: boolean | undefined;
  errorClass?: string | undefined;
  /** Seen a later status/cancel/thread tool for this child. */
  followed: boolean;
}

export interface DelegationSummary {
  calls: number;
  perModel: Record<string, number>;
  perRole: Record<string, number>;
  perMode: Record<string, number>;
  errors: number;
  errorRate: number;
  errorClasses: Record<string, number>;
  /** Async delegate_task children with a result and no later check. */
  orphans: number;
  /** Same task text sent again after a `fetch failed`. */
  retryDuplicates: number;
  peakChildren: number;
  peakSession: string | undefined;
  sessions: number;
}

const bump = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export function summarizeCalls(calls: CallRec[]): DelegationSummary {
  const s: DelegationSummary = {
    calls: calls.length,
    perModel: {},
    perRole: {},
    perMode: {},
    errors: 0,
    errorRate: 0,
    errorClasses: {},
    orphans: 0,
    retryDuplicates: 0,
    peakChildren: 0,
    peakSession: undefined,
    sessions: 0,
  };
  const perSession = new Map<string, CallRec[]>();
  for (const c of calls) {
    bump(s.perModel, c.model ?? "(default)");
    bump(s.perRole, c.role ?? "(none)");
    bump(s.perMode, c.mode ?? "(none)");
    if (c.ok === false) {
      s.errors++;
      bump(s.errorClasses, c.errorClass ?? "other");
    }
    if (c.tool === "delegate_task" && c.mode !== "wait" && c.ok === true && !c.followed)
      s.orphans++;
    const list = perSession.get(c.session) ?? [];
    list.push(c);
    perSession.set(c.session, list);
  }
  s.errorRate = calls.length ? s.errors / calls.length : 0;
  s.sessions = perSession.size;
  for (const [id, list] of perSession) {
    if (list.length > s.peakChildren) {
      s.peakChildren = list.length;
      s.peakSession = id;
    }
    const failed = new Set<string>();
    for (const c of list) {
      if (failed.has(c.taskSha1)) s.retryDuplicates++;
      if (c.ok === false && c.errorClass === "fetch-failed") failed.add(c.taskSha1);
    }
  }
  return s;
}

const parseLines = (jsonl: string): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {}
  }
  return out;
};

const FOLLOW = new Set([
  "task_status",
  "task_cancel",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_send",
]);
const START = new Set(["delegate_task", "t3_thread_launch", "create_threads"]);

/** Part (a): build CallRecs from the raw lines of ONE session file. */
export function callsFromSession(session: string, jsonl: string): CallRec[] {
  const calls: (CallRec & { callId: string; ids: Set<string> })[] = [];
  const byCall = new Map<string, typeof calls>();
  const follows: { index: number; id: string }[] = [];
  const texts = new Map<string, { text: string; isError: boolean }>();
  let index = 0;
  for (const o of parseLines(jsonl)) {
    const m = o["message"] as Record<string, unknown> | undefined;
    if (!m) continue;
    if (m["role"] === "assistant" && Array.isArray(m["content"])) {
      for (const c of m["content"] as Record<string, unknown>[]) {
        if (c["type"] !== "toolCall" || typeof c["name"] !== "string") continue;
        const tool = shortName(c["name"]);
        if (!c["name"].includes("t3-code__") && !c["name"].includes("t3_code__")) continue;
        index++;
        const args = (c["arguments"] ?? {}) as Record<string, unknown>;
        if (FOLLOW.has(tool)) {
          const id = args["taskId"] ?? args["threadId"];
          if (typeof id === "string") follows.push({ index, id: sha1(id) });
        } else if (START.has(tool)) {
          const list = describeCall(tool, args).map((i) => ({
            session,
            tool,
            role: i.role,
            mode: i.mode,
            model: i.model,
            taskSha1: i.taskSha1,
            ok: undefined as boolean | undefined,
            errorClass: undefined as string | undefined,
            followed: false,
            callId: String(c["id"]),
            ids: new Set<string>(),
            at: index,
          }));
          byCall.set(String(c["id"]), list);
          calls.push(...list);
        }
      }
    } else if (m["role"] === "toolResult" && typeof m["toolCallId"] === "string") {
      const first = Array.isArray(m["content"])
        ? (m["content"] as Record<string, unknown>[])[0]
        : undefined;
      texts.set(m["toolCallId"], {
        text: typeof first?.["text"] === "string" ? first["text"] : "",
        isError: m["isError"] === true,
      });
    }
  }
  // Follow-ups only count when they come after the start; approximate with order of appearance.
  // (A task id exists only after the result, so any match is later.)
  const followIds = new Set(follows.map((f) => f.id));
  for (const [callId, list] of byCall) {
    const r = texts.get(callId);
    if (!r) continue;
    const info = r.isError ? {} : parseResult(r.text);
    for (const c of list) {
      c.ok = !r.isError;
      if (r.isError) c.errorClass = classifyError(r.text);
      if (info.taskId && followIds.has(sha1(info.taskId))) c.followed = true;
      if (info.childThreadId && followIds.has(sha1(info.childThreadId))) c.followed = true;
    }
  }
  return calls.map(({ callId: _a, ids: _b, ...rest }) => rest as CallRec);
}

/** Part (a) over a directory tree of session files. */
export function historyCalls(dir: string = SESSIONS_DIR): CallRec[] {
  const out: CallRec[] = [];
  if (!existsSync(dir)) return out;
  for (const d of readdirSync(dir)) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, d)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      let text = "";
      try {
        text = readFileSync(join(dir, d, f), "utf8");
      } catch {
        continue;
      }
      if (!text.includes("t3-code__") && !text.includes("t3_code__")) continue;
      out.push(...callsFromSession(`${d}/${f}`, text));
    }
  }
  return out;
}

export interface LiveSummary extends DelegationSummary {
  wouldBlock: Record<string, number>;
  blocked: Record<string, number>;
}

/** Part (b): the live JSONL written by the extension. */
export function liveSummary(jsonl: string): LiveSummary {
  const recs = parseLines(jsonl);
  const calls = new Map<string, CallRec[]>();
  const all: CallRec[] = [];
  const wouldBlock: Record<string, number> = {};
  const blocked: Record<string, number> = {};
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const key = (r: Record<string, unknown>) => `${str(r["session"])}|${str(r["callId"])}`;
  for (const r of recs) {
    if (r["event"] === "call") {
      const c: CallRec = {
        session: str(r["session"]) ?? "?",
        tool: str(r["tool"]) ?? "?",
        role: str(r["role"]),
        mode: str(r["mode"]),
        model: str(r["model"]),
        taskSha1: str(r["taskSha1"]) ?? "",
        followed: false,
      };
      const list = calls.get(key(r)) ?? [];
      list.push(c);
      calls.set(key(r), list);
      all.push(c);
    } else if (r["event"] === "would_block") bump(wouldBlock, str(r["rule"]) ?? "?");
    else if (r["event"] === "block") bump(blocked, str(r["rule"]) ?? "?");
  }
  for (const r of recs) {
    if (r["event"] === "result") {
      for (const c of calls.get(key(r)) ?? []) {
        c.ok = r["ok"] === true;
        if (!c.ok) c.errorClass = str(r["errorClass"]) ?? "other";
      }
    } else if (r["event"] === "followup" && r["linkedCall"]) {
      for (const c of calls.get(`${str(r["session"])}|${str(r["linkedCall"])}`) ?? [])
        c.followed = true;
    }
  }
  return { ...summarizeCalls(all), wouldBlock, blocked };
}

const top = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(", ") || "-";

export function formatSummary(title: string, s: DelegationSummary | LiveSummary): string {
  const lines = [
    `## ${title}`,
    `Delegations: ${s.calls} in ${s.sessions} sessions`,
    `Per model: ${top(s.perModel)}`,
    `Per role: ${top(s.perRole)}`,
    `Per mode: ${top(s.perMode)}`,
    `Errors: ${s.errors} (${(s.errorRate * 100).toFixed(1)}%) — classes: ${top(s.errorClasses)}`,
    `Async children never checked (T3 wakes the parent on completion, so not necessarily lost): ${s.orphans}`,
    `Retry duplicates after fetch failed: ${s.retryDuplicates}`,
    `Peak children in one session: ${s.peakChildren}`,
  ];
  if ("wouldBlock" in s)
    lines.push(`would_block per rule: ${top(s.wouldBlock)}`, `blocked per rule: ${top(s.blocked)}`);
  return lines.join("\n");
}

if (import.meta.main) {
  console.log(formatSummary("History (all sessions)", summarizeCalls(historyCalls())));
  console.log("");
  if (existsSync(LIVE_LOG))
    console.log(formatSummary("Live log", liveSummary(readFileSync(LIVE_LOG, "utf8"))));
  else console.log(`## Live log\nNo log file at ${LIVE_LOG}`);
}
