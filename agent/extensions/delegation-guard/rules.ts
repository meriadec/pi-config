import { createHash } from "node:crypto";

export type Mode = "shadow" | "live" | "off";
export type Rec = Record<string, unknown>;

export const DEFAULT_MAX = 6;
export const DELEGATE_TOOLS = ["delegate_task", "t3_thread_launch", "create_threads"] as const;
/** Tools that show interest in an earlier child. */
export const FOLLOW_TOOLS = [
  "task_status",
  "task_cancel",
  "t3_thread_read",
  "t3_thread_wait",
  "t3_thread_send",
] as const;
export const ORPHAN_TOOLS = "task_status, task_cancel, t3_thread_read";

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

export function parseMode(value: string | undefined): Mode {
  const v = value?.trim().toLowerCase();
  return v === "live" || v === "off" ? v : "shadow";
}

export function parseMax(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX;
}

/** `mcp__t3-code__delegate_task` -> `delegate_task`. */
export const shortName = (name: string) => name.split("__").pop() ?? name;

export type ErrorClass = "fetch-failed" | "other";
export const classifyError = (text: string): ErrorClass =>
  /fetch failed/i.test(text) ? "fetch-failed" : "other";

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export interface ChildInfo {
  tool: string;
  role?: string;
  mode?: string;
  isolation?: string;
  model?: string;
  taskLen: number;
  taskSha1: string;
  hasClientRequestId: boolean;
}

function describeOne(tool: string, item: Record<string, unknown>, text: unknown): ChildInfo {
  const t = typeof text === "string" ? text : "";
  const ws = obj(item["workspaceStrategy"]);
  const info: ChildInfo = {
    tool,
    taskLen: Buffer.byteLength(t),
    taskSha1: sha1(t),
    hasClientRequestId: !!str(item["clientRequestId"]),
  };
  const role = str(item["role"]);
  if (role) info.role = role;
  if (tool === "delegate_task") info.mode = str(item["mode"]) ?? "async";
  else info.mode = "thread";
  const isolation = str(item["isolation"]) ?? str(ws["type"]);
  if (isolation) info.isolation = isolation;
  else if (tool === "delegate_task") info.isolation = "shared";
  const model = str(obj(item["target"])["model"]) ?? str(item["model"]);
  if (model) info.model = model;
  return info;
}

/** One entry per child that the call starts. create_threads with N threads gives N. */
export function describeCall(tool: string, input: unknown): ChildInfo[] {
  const i = obj(input);
  if (tool === "delegate_task") return [describeOne(tool, i, i["task"])];
  if (tool === "t3_thread_launch") return [describeOne(tool, i, i["message"])];
  if (tool === "create_threads") {
    const list = Array.isArray(i["threads"]) ? i["threads"] : [];
    if (list.length === 0) return [describeOne(tool, i, i["message"])];
    return list.map((t) => {
      const o = obj(t);
      return describeOne(tool, o, o["message"] ?? o["prompt"] ?? o["task"]);
    });
  }
  return [];
}

export interface ResultInfo {
  taskId?: string;
  childThreadId?: string;
  status?: string;
}

export function parseResult(text: string): ResultInfo {
  try {
    const j = obj(JSON.parse(text));
    const r: ResultInfo = {};
    const taskId = str(j["taskId"]);
    const childThreadId = str(j["childThreadId"]);
    const status = str(j["status"]);
    if (taskId) r.taskId = taskId;
    if (childThreadId) r.childThreadId = childThreadId;
    if (status) r.status = status;
    return r;
  } catch {
    return {};
  }
}

export interface Block {
  rule: "child-cap" | "duplicate";
  reason: string;
}

interface Child {
  callId: string;
  tool: string;
  mode: string | undefined;
  ok: boolean;
  taskIdHash?: string;
  childHash?: string;
  followed: boolean;
}

interface Attempt {
  callId: string;
  hasCrid: boolean;
  result?: "ok" | ErrorClass;
}

/** Per-session state. Pure: it returns log records and decisions, and does no I/O. */
export class DelegationState {
  private started = 0;
  private attempts = new Map<string, Attempt[]>(); // task sha1 -> attempts
  private byCall = new Map<string, Attempt[]>();
  private children = new Map<string, Child>(); // callId -> child
  private blocked = new Set<string>();
  private lastOrphanKey = "";

  private opts: { mode: Mode; max: number };
  constructor(opts: { mode: Mode; max: number }) {
    this.opts = opts;
  }

  onCall(callId: string, tool: string, input: unknown): { records: Rec[]; block?: Block } {
    const infos = describeCall(tool, input);
    if (infos.length === 0) return { records: [] };
    const records: Rec[] = infos.map((i) => ({
      event: "call",
      callId,
      tool,
      role: i.role,
      mode: i.mode,
      isolation: i.isolation,
      model: i.model,
      taskLen: i.taskLen,
      taskSha1: i.taskSha1,
      hasClientRequestId: i.hasClientRequestId,
    }));
    const block = this.decide(infos);
    if (block) {
      records.push({
        event: this.opts.mode === "live" ? "block" : "would_block",
        callId,
        tool,
        rule: block.rule,
      });
      if (this.opts.mode === "live") {
        this.blocked.add(callId);
        return { records, block };
      }
    }
    this.started += infos.length;
    const list: Attempt[] = [];
    for (const i of infos) {
      const a: Attempt = { callId, hasCrid: i.hasClientRequestId };
      list.push(a);
      const prior = this.attempts.get(i.taskSha1) ?? [];
      prior.push(a);
      this.attempts.set(i.taskSha1, prior);
    }
    this.byCall.set(callId, list);
    if (tool === "delegate_task") {
      this.children.set(callId, {
        callId,
        tool,
        mode: infos[0]?.mode,
        ok: false,
        followed: false,
      });
    }
    return { records };
  }

  private decide(infos: ChildInfo[]): Block | undefined {
    if (this.started + infos.length > this.opts.max) {
      return {
        rule: "child-cap",
        reason: `Delegation cap reached: ${this.started} children already started in this session (max ${this.opts.max}). Check or cancel them with ${ORPHAN_TOOLS}, or set PI_DELEGATION_MAX=<n> before you start Pi.`,
      };
    }
    for (const i of infos) {
      if (i.hasClientRequestId) continue;
      const prior = this.attempts.get(i.taskSha1) ?? [];
      const failed = prior.some((a) => a.result === "fetch-failed");
      const pending = prior.some((a) => a.result === undefined && !a.hasCrid);
      if (failed || pending) {
        return {
          rule: "duplicate",
          reason: `Same task was sent before and ${failed ? "failed with 'fetch failed' (the child may exist)" : "has no result yet"}. A retry without clientRequestId can start a duplicate child. First look for the earlier child (task_status, t3_thread_search). If you must retry, repeat the call with a clientRequestId, for example "clientRequestId": "retry-${i.taskSha1.slice(0, 8)}".`,
        };
      }
    }
    return undefined;
  }

  onResult(callId: string, tool: string, text: string, isError: boolean): Rec[] {
    const list = this.byCall.get(callId);
    if (!list) return [];
    const ok = !isError;
    const errorClass = ok ? undefined : classifyError(text);
    const info = ok ? parseResult(text) : {};
    for (const a of list) a.result = ok ? "ok" : (errorClass ?? "other");
    const child = this.children.get(callId);
    if (child && ok) {
      child.ok = true;
      if (info.taskId) child.taskIdHash = sha1(info.taskId);
      if (info.childThreadId) child.childHash = sha1(info.childThreadId);
    }
    return [
      {
        event: "result",
        callId,
        tool,
        ok,
        errorClass,
        taskIdHash: info.taskId ? sha1(info.taskId) : undefined,
        childHash: info.childThreadId ? sha1(info.childThreadId) : undefined,
        status: info.status,
        count: list.length,
      },
    ];
  }

  /** task_status, task_cancel and thread tools: link to the earlier delegation. */
  onFollowup(tool: string, input: unknown): Rec[] {
    const i = obj(input);
    const id = str(i["taskId"]) ?? str(i["threadId"]);
    if (!id) return [];
    const h = sha1(id);
    let linked: string | undefined;
    for (const c of this.children.values()) {
      if (c.taskIdHash === h || c.childHash === h) {
        c.followed = true;
        linked = c.callId;
      }
    }
    return [{ event: "followup", tool, targetHash: h, linkedCall: linked }];
  }

  private orphans(): Child[] {
    return [...this.children.values()].filter((c) => c.ok && c.mode !== "wait" && !c.followed);
  }

  /** At agent_end. Logs once per distinct set of unchecked async children. Never sends a message. */
  onAgentEnd(): { records: Rec[]; message?: string } {
    const orphans = this.orphans();
    const key = orphans
      .map((c) => c.callId)
      .sort()
      .join("|");
    if (key === this.lastOrphanKey) return { records: [] };
    this.lastOrphanKey = key;
    if (orphans.length === 0) return { records: [] };
    // Log only, in every mode. T3 wakes the parent when an async child ends, so "never checked" is not "lost".
    // A message here would push the agent to poll, which T3 tells it not to do.
    return { records: [{ event: "unchecked-async", orphans: orphans.length }] };
  }
}
