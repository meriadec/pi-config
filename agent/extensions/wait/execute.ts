import { chooseRoute, type Route } from "./route.ts";
import { pickByMatch, type TaggedProcess } from "./procscan.ts";
import type { LocalSpec, LocalWait } from "./runner.ts";
import { parseWaitSpec } from "./spec.ts";

/** What `wait_for`, `wait_list` and `wait_cancel` do. Pure logic: all I/O comes in through `WaitEnv`. */

export const LOCAL_NOTE =
  "Local waits end when this session ends or reloads; PR watches and timers of 60 s or more are kept by T3.";
export const PR_NOTE =
  "T3 wakes this thread on ANY event of that PR (reviews, checks, comments, conflicts): it has no filter. Look at what changed before you act.";

export interface ToolOutcome {
  isError: boolean;
  result: { content: readonly { type: string; text?: string }[]; structuredContent?: unknown };
}

export interface WaitEnv {
  tools: readonly { name: string }[];
  executeTool(name: string, args: unknown): Promise<ToolOutcome>;
  /** Lazy: the runner starts its timer on first use. */
  runner(): {
    add(spec: LocalSpec, opts?: { note?: string }): LocalWait;
    list(): LocalWait[];
    cancel(id: string): boolean;
  };
  remote: RemoteWaits;
  now(): number;
  findTagged(): Promise<TaggedProcess[]>;
}

export interface ToolText {
  content: [{ type: "text"; text: string }];
  details: { route?: string; tool?: string; error?: string; id?: string };
  isError: boolean;
}

const text = (t: string, details: ToolText["details"] = {}, isError = false): ToolText => ({
  content: [{ type: "text", text: t }],
  details,
  isError,
});

const fail = (route: string, tool: string, error: string): ToolText =>
  text(error, { route, tool, error }, true);

/** PR watches and T3 timers made by `wait_for`. In memory: T3 itself keeps the real ones. */
interface RemoteWait {
  id: string;
  kind: "pr" | "timer";
  description: string;
  /** Timers: when T3 runs it. A PR watch has none. */
  runAt?: number;
  stop: { tool: string; args: unknown } | undefined;
  /** For a PR watch: the URL, so a second wait on the same PR makes no second entry. */
  key?: string;
}

export class RemoteWaits {
  private readonly items = new Map<string, RemoteWait>();
  private seq = { p: 0, t: 0 };

  add(w: Omit<RemoteWait, "id">): RemoteWait {
    const prefix = w.kind === "pr" ? "p" : "t";
    const id = `${prefix}${++this.seq[prefix]}`;
    const item = { ...w, id };
    this.items.set(id, item);
    return item;
  }

  findByKey(key: string): RemoteWait | undefined {
    return [...this.items.values()].find((i) => i.key === key);
  }

  get(id: string): RemoteWait | undefined {
    return this.items.get(id);
  }

  remove(id: string): void {
    this.items.delete(id);
  }

  /** Timers that already ran in T3 are dropped. */
  list(now: number): RemoteWait[] {
    for (const i of this.items.values()) {
      if (i.runAt !== undefined && i.runAt <= now) this.items.delete(i.id);
    }
    return [...this.items.values()];
  }
}

type T3Result = { ok: true; body: unknown } | { ok: false; error: string };

/** Run a T3 tool by its short name. T3 tools carry an `mcp__…__` prefix, so match on the suffix. */
export async function callT3(env: WaitEnv, short: string, args: unknown): Promise<T3Result> {
  const tool = env.tools.find((t) => t.name === short || t.name.endsWith(`__${short}`));
  if (!tool) return { ok: false, error: `T3 tool ${short} is not available in this session.` };
  let outcome: ToolOutcome;
  try {
    outcome = await env.executeTool(tool.name, args);
  } catch (e) {
    return { ok: false, error: `T3 ${short} failed: ${(e as Error).message.slice(0, 300)}` };
  }
  const first = outcome.result.content.find((c) => c.type === "text");
  const body = first?.text ?? "";
  if (outcome.isError) return { ok: false, error: `T3 ${short} failed: ${body.slice(0, 300)}` };
  if (outcome.result.structuredContent !== undefined)
    return { ok: true, body: outcome.result.structuredContent };
  try {
    return { ok: true, body: JSON.parse(body) };
  } catch {
    return { ok: true, body };
  }
}

/** Find a string value by key in a parsed T3 result. */
function findKey(body: unknown, key: string, depth = 0): string | undefined {
  if (typeof body !== "object" || body === null || depth > 4) return undefined;
  for (const [k, v] of Object.entries(body)) {
    if (k === key && typeof v === "string") return v;
    const inner = findKey(v, key, depth + 1);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

export async function executeWait(input: unknown, env: WaitEnv): Promise<ToolText> {
  let spec: ReturnType<typeof parseWaitSpec>;
  try {
    spec = parseWaitSpec(input);
  } catch (e) {
    return fail("none", "parseWaitSpec", (e as Error).message);
  }
  const note = (input as { note?: unknown }).note;
  const noteText = typeof note === "string" ? note : undefined;
  const route: Route = chooseRoute(spec);

  if (route.via === "t3.watch_pull_request" && "pr" in spec) {
    const done = await callT3(env, "watch_pull_request", { url: spec.pr });
    if (!done.ok) return fail(route.via, "watch_pull_request", done.error);
    const known = env.remote.findByKey(spec.pr);
    const item =
      known ??
      env.remote.add({
        kind: "pr",
        description: `PR watch ${spec.pr}`,
        key: spec.pr,
        stop: { tool: "unwatch_pull_request", args: { url: spec.pr } },
      });
    return text(`Watching ${spec.pr} as ${item.id}. ${PR_NOTE} End your turn.`, {
      route: route.via,
      id: item.id,
    });
  }

  if (route.via === "t3.schedule_task" && spec.event === "time") {
    const runAt = env.now() + spec.afterMs;
    const done = await callT3(env, "schedule_task", {
      title: "Wait over",
      prompt: noteText ?? "The wait you asked for is over.",
      schedule: { type: "once", runAt: new Date(runAt).toISOString() },
    });
    if (!done.ok) return fail(route.via, "schedule_task", done.error);
    const taskId = findKey(done.body, "scheduledTaskId");
    const item = env.remote.add({
      kind: "timer",
      description: `T3 timer at ${new Date(runAt).toISOString()}`,
      runAt,
      stop:
        taskId === undefined
          ? undefined
          : { tool: "delete_scheduled_task", args: { scheduledTaskId: taskId } },
    });
    const warn = taskId === undefined ? " T3 gave no task id, so wait_cancel cannot stop it." : "";
    return text(
      `Timer ${item.id} scheduled in T3 for ${new Date(runAt).toISOString()}. T3 keeps it if Pi restarts.${warn} End your turn.`,
      { route: route.via, id: item.id },
    );
  }

  let local: LocalSpec;
  if (spec.event === "process.exit") {
    let pid = spec.pid;
    if (pid === undefined) {
      const found = pickByMatch(await env.findTagged().catch(() => []), spec.match ?? "");
      if (!found.ok) return fail("local-runner", "findTagged", found.error);
      pid = found.process.pid;
    }
    local = { event: "process.exit", label: spec.label, pid };
  } else if (spec.event === "time" || spec.event === "http.ready") {
    local = spec;
  } else {
    return fail(route.via, "none", "unsupported wait");
  }
  try {
    const wait = env.runner().add(local, noteText === undefined ? {} : { note: noteText });
    const only =
      local.event === "http.ready" ? " It fires on the first answer with a status below 500." : "";
    return text(
      `Wait ${wait.id} is active.${only} I message you when it fires. ${LOCAL_NOTE} End your turn.`,
      { route: "local-runner", id: wait.id },
    );
  } catch (e) {
    return fail("local-runner", "runner", (e as Error).message);
  }
}

export async function listWaits(env: WaitEnv): Promise<ToolText> {
  const procs = await env.findTagged().catch(() => []);
  const lines = [
    ...env
      .runner()
      .list()
      .map((w) => `${w.id}: local ${w.spec.event} ${JSON.stringify(w.spec)}`),
    ...env.remote.list(env.now()).map((r) => `${r.id}: ${r.description}`),
    ...procs.map((pr) => `pid ${pr.pid} (${Math.round(pr.ageSeconds / 60)} min): ${pr.command}`),
  ];
  return text(lines.length ? lines.join("\n") : "No waits and no leftover processes.");
}

export async function cancelWait(id: string, env: WaitEnv): Promise<ToolText> {
  const remote = env.remote.get(id);
  if (remote) {
    if (!remote.stop)
      return fail("t3", "delete_scheduled_task", `No task id is known for ${id}; stop it in T3.`);
    const done = await callT3(env, remote.stop.tool, remote.stop.args);
    if (!done.ok) return fail("t3", remote.stop.tool, done.error);
    env.remote.remove(id);
    return text(`Cancelled ${id} in T3.`, { route: "t3", tool: remote.stop.tool, id });
  }
  return text(env.runner().cancel(id) ? `Cancelled ${id}.` : `No wait ${id}.`);
}
