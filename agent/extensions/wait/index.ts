import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { detectPolling, pollingHint } from "./polling.ts";
import { describeLeftovers, findTagged, SESSION_TAG_ENV } from "./procscan.ts";
import { chooseRoute } from "./route.ts";
import { LocalRunner, type LocalWait } from "./runner.ts";
import { parseWaitSpec, type WaitSpec } from "./spec.ts";

const LEFTOVER_MIN_AGE_S = 30;

const params = Type.Object({
  event: StringEnum([
    "pr.review",
    "pr.checks",
    "pr.merged",
    "time",
    "process.exit",
    "http.ready",
  ] as const),
  pr: Type.Optional(Type.String({ description: "Full GitHub pull request URL (pr.* events)" })),
  afterMs: Type.Optional(Type.Number({ description: "Delay in milliseconds (time event)" })),
  pid: Type.Optional(
    Type.Number({ description: "Process id, for example $! (process.exit event)" }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short name of the process (process.exit event)" }),
  ),
  url: Type.Optional(Type.String({ description: "URL to probe (http.ready event)" })),
  note: Type.Optional(Type.String({ description: "Text to show again when the wait fires" })),
});

const text = (t: string, isError = false) => ({
  content: [{ type: "text" as const, text: t }],
  details: {},
  isError,
});

async function httpUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Run a T3 tool by its short name. T3 tools carry an `mcp__…__` prefix, so match on the suffix. */
async function callT3(
  ctx: ExtensionToolContext,
  short: string,
  args: unknown,
): Promise<string | undefined> {
  const tool = ctx.tools.find((t) => t.name === short || t.name.endsWith(`__${short}`));
  if (!tool) return `T3 tool ${short} is not available in this session.`;
  const outcome = await ctx.executeTool(tool.name, args);
  const first = outcome.result.content.find((c) => c.type === "text");
  const body = first && "text" in first ? first.text : "";
  return outcome.isError ? `T3 ${short} failed: ${body.slice(0, 300)}` : undefined;
}

export default function (pi: ExtensionAPI) {
  const sessionId = randomUUID();
  let runner: LocalRunner | undefined;
  let announced = "";

  const getRunner = () =>
    (runner ??= new LocalRunner({
      now: Date.now,
      isAlive,
      probeHttp: httpUp,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      fire: (_w: LocalWait, message: string) =>
        pi.sendUserMessage(`[wait fired] ${message}`, { deliverAs: "followUp" }),
    }));

  pi.on("session_start", () => {
    process.env[SESSION_TAG_ENV] = sessionId;
  });

  pi.on("session_shutdown", () => {
    runner?.stopAll();
    runner = undefined;
    delete process.env[SESSION_TAG_ENV];
  });

  // Option A, soft: never block a command, only add a hint to its result.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    const kind = typeof command === "string" ? detectPolling(command) : undefined;
    if (!kind) return;
    return {
      content: [...event.content, { type: "text" as const, text: `\n[hint] ${pollingHint(kind)}` }],
    };
  });

  // Option C: tell the thread about processes that outlive the turn.
  pi.on("agent_end", async (_event, ctx) => {
    if (ctx.hasPendingMessages()) return;
    const note = describeLeftovers(await findTagged(sessionId, LEFTOVER_MIN_AGE_S).catch(() => []));
    if (note === announced) return;
    announced = note;
    if (note)
      pi.sendMessage({ customType: "wait-leftovers", content: note, display: true, details: {} });
  });

  pi.registerTool({
    name: "wait_for",
    label: "Wait for",
    description:
      "Wait for an event and get woken when it happens. Use it for a PR review or checks, a timer, a process exit, or a URL that becomes ready. Never poll with sleep or gh loops. After the call, end your turn.",
    promptGuidelines: [
      "Use wait_for to wait for any event (PR review, CI, timer, process exit, HTTP ready) instead of sleep loops or polling commands.",
    ],
    parameters: params,
    async execute(_id, p, _signal, _onUpdate, ctx) {
      let spec: WaitSpec;
      try {
        spec = parseWaitSpec(p);
      } catch (e) {
        return text((e as Error).message, true);
      }
      const route = chooseRoute(spec);
      if (route.via === "t3.watch_pull_request" && "pr" in spec) {
        const err = await callT3(ctx, "watch_pull_request", { url: spec.pr });
        if (err) return text(err, true);
        const extra = route.note ? ` Note: ${route.note}.` : "";
        return text(
          `Watching ${spec.pr}. T3 wakes this thread on reviews, checks and conflicts. End your turn.${extra}`,
        );
      }
      if (route.via === "t3.schedule_task" && spec.event === "time") {
        const err = await callT3(ctx, "schedule_task", {
          title: "Wait over",
          prompt: p.note ?? "The wait you asked for is over.",
          schedule: { type: "once", runAt: new Date(Date.now() + spec.afterMs).toISOString() },
        });
        if (err) return text(err, true);
        return text("Scheduled a T3 task for this thread. End your turn.");
      }
      try {
        const wait = getRunner().add(
          spec as LocalWait["spec"],
          p.note === undefined ? {} : { note: p.note },
        );
        return text(`Wait ${wait.id} is active. I message you when it fires. End your turn.`);
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  });

  pi.registerTool({
    name: "wait_list",
    label: "List waits",
    description: "List local waits and processes this session started that still run.",
    parameters: Type.Object({}),
    async execute() {
      const waits = runner?.list() ?? [];
      const procs = await findTagged(sessionId, 0).catch(() => []);
      const lines = [
        ...waits.map((w) => `${w.id}: ${w.spec.event} ${JSON.stringify(w.spec)}`),
        ...procs.map(
          (pr) => `pid ${pr.pid} (${Math.round(pr.ageSeconds / 60)} min): ${pr.command}`,
        ),
      ];
      return text(lines.length ? lines.join("\n") : "No local waits and no leftover processes.");
    },
  });

  pi.registerTool({
    name: "wait_cancel",
    label: "Cancel wait",
    description:
      "Cancel a local wait by id (from wait_list). T3 PR watches stop with unwatch_pull_request.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) {
      return text(runner?.cancel(p.id) ? `Cancelled ${p.id}.` : `No local wait ${p.id}.`);
    },
  });
}
