import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { cancelWait, executeWait, listWaits, RemoteWaits, type WaitEnv } from "./execute.ts";
import { detectPolling, pollingHint } from "./polling.ts";
import { httpUp, isAlive } from "./probe.ts";
import { LeftoverWatch } from "./leftovers.ts";
import { findTagged, SESSION_TAG_ENV } from "./procscan.ts";
import { LocalRunner, type LocalWait } from "./runner.ts";

const LEFTOVER_MIN_AGE_S = 30;

const params = Type.Object({
  event: StringEnum(["pr.review", "pr.checks", "time", "process.exit", "http.ready"] as const),
  pr: Type.Optional(Type.String({ description: "Full GitHub pull request URL (pr.* events)" })),
  afterMs: Type.Optional(Type.Number({ description: "Delay in milliseconds (time event)" })),
  pid: Type.Optional(
    Type.Number({ description: "Process id, for example $! (process.exit event)" }),
  ),
  match: Type.Optional(
    Type.String({
      description:
        "Instead of pid: text in the command line of ONE process this session started (process.exit event)",
    }),
  ),
  label: Type.Optional(
    Type.String({ description: "Short name of the process (process.exit event)" }),
  ),
  url: Type.Optional(
    Type.String({
      description: "URL to probe (http.ready event). Fires on the first answer below 500.",
    }),
  ),
  note: Type.Optional(Type.String({ description: "Text to show again when the wait fires" })),
});

export default function (pi: ExtensionAPI) {
  const sessionId = randomUUID();
  let runner: LocalRunner | undefined;
  /** True between `session_shutdown` and the next `session_start`. No message may leave then. */
  let shutDown = false;
  const remote = new RemoteWaits();

  const getRunner = () =>
    (runner ??= new LocalRunner({
      now: Date.now,
      isAlive,
      probeHttp: httpUp,
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      fire: (_w: LocalWait, message: string) => {
        if (shutDown) return;
        pi.sendUserMessage(`[wait fired] ${message}`, { deliverAs: "followUp" });
      },
    }));

  const envFor = (ctx: {
    tools: WaitEnv["tools"];
    executeTool: WaitEnv["executeTool"];
  }): WaitEnv => ({
    tools: ctx.tools,
    executeTool: (name, args) => ctx.executeTool(name, args),
    runner: getRunner,
    remote,
    now: Date.now,
    findTagged: () => findTagged(sessionId, 0),
  });

  pi.on("session_start", () => {
    shutDown = false;
    process.env[SESSION_TAG_ENV] = sessionId;
  });

  pi.on("session_shutdown", () => {
    shutDown = true;
    runner?.stopAll();
    runner = undefined;
    if (process.env[SESSION_TAG_ENV] === sessionId) delete process.env[SESSION_TAG_ENV];
  });

  // Assumption: one Pi session per process. Re-assert the tag so a command always carries it.
  pi.on("tool_call", (event) => {
    if (event.toolName !== "bash" || shutDown) return;
    process.env[SESSION_TAG_ENV] = sessionId;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command === "string") leftovers.noteBashCommand(command);
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

  const leftovers = new LeftoverWatch(
    () => findTagged(sessionId, LEFTOVER_MIN_AGE_S),
    (note) => {
      if (!shutDown)
        pi.sendMessage({ customType: "wait-leftovers", content: note, display: true, details: {} });
    },
  );

  pi.on("agent_end", async (_event, ctx) => {
    if (shutDown || ctx.hasPendingMessages()) return;
    await leftovers.onAgentEnd();
  });

  pi.registerTool({
    name: "wait_for",
    label: "Wait for",
    description:
      "Wait for an event and get woken when it happens. Use it for a PR event, a timer, a process exit, or a URL that becomes ready. Never poll with sleep or gh loops. After the call, end your turn. " +
      "Local waits (process.exit, http.ready, timers) end when this session ends or reloads; only PR watches are kept by T3. " +
      "pr.review and pr.checks both start the same T3 watch: T3 wakes this thread on ANY PR event (reviews, checks, comments, conflicts) because it has no filter. It does not wake on merge. " +
      "process.exit takes pid, or match (text in the command line of exactly one process this session started). " +
      "http.ready waits for ONE answer with a status below 500; it does not check the body or retry.",
    promptGuidelines: [
      "Use wait_for to wait for any event (PR event, timer, process exit, HTTP ready) instead of sleep loops or polling commands.",
    ],
    parameters: params,
    async execute(_id, p, _signal, _onUpdate, ctx) {
      return executeWait(p, envFor(ctx));
    },
  });

  pi.registerTool({
    name: "wait_list",
    label: "List waits",
    description:
      "List waits made by wait_for (local waits, PR watches) and processes this session started that still run.",
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _onUpdate, ctx) {
      return listWaits(envFor(ctx));
    },
  });

  pi.registerTool({
    name: "wait_cancel",
    label: "Cancel wait",
    description:
      "Cancel a wait by id (from wait_list): a local wait, or a PR watch (unwatch_pull_request).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      return cancelWait(p.id, envFor(ctx));
    },
  });
}
