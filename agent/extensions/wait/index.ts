import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { ActiveWaits } from "./active.ts";
import { cancelWait, executeWait, listWaits, type WaitEnv } from "./execute.ts";
import { ghPrView } from "./gh.ts";
import { sleep } from "./until.ts";
import { detectPolling, pollingHint } from "./polling.ts";
import { httpUp, isAlive } from "./probe.ts";
import { LeftoverWatch } from "./leftovers.ts";
import { findTagged, SESSION_TAG_ENV } from "./procscan.ts";
import { statusLine } from "./status.ts";

const LEFTOVER_MIN_AGE_S = 30;

const params = Type.Object({
  event: StringEnum([
    "pr.merged",
    "pr.checks.done",
    "pr.review",
    "pr.approved",
    "time",
    "process.exit",
    "http.ready",
  ] as const),
  pr: Type.Optional(Type.String({ description: "Full GitHub pull request URL (pr.* events)" })),
  reviewer: Type.Optional(
    Type.String({
      description:
        "Only for pr.review and pr.approved: part of the reviewer login, for example copilot",
    }),
  ),
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
  note: Type.Optional(Type.String({ description: "Text to add to the result when the wait ends" })),
});

export default function (pi: ExtensionAPI) {
  const sessionId = randomUUID();
  /** True between `session_shutdown` and the next `session_start`. */
  let shutDown = false;
  const active = new ActiveWaits();

  const envFor = (): WaitEnv => ({
    conditions: {
      now: Date.now,
      prView: ghPrView,
      isAlive,
      probeHttp: httpUp,
    },
    until: { sleep },
    active,
    findTagged: () => findTagged(sessionId, 0),
    onChange: refreshStatus,
  });

  /**
   * Footer feedback. In T3 this becomes the "Pi · ..." banner above the composer. A wait also keeps
   * its tool call open, so T3 shows the thread as working and its Stop button aborts the wait.
   * The text is static, so it is set only when the waits change, never on a clock.
   */
  let ui: { setStatus(key: string, text: string | undefined): void } | undefined;
  const refreshStatus = () => {
    ui?.setStatus("wait", shutDown ? undefined : statusLine(active.list().map((w) => w.label)));
  };

  pi.on("session_start", () => {
    shutDown = false;
    process.env[SESSION_TAG_ENV] = sessionId;
  });

  pi.on("session_shutdown", () => {
    shutDown = true;
    active.cancelAll();
    refreshStatus();
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

  const trackUi = (ctx: { hasUI: boolean; ui: NonNullable<typeof ui> }) => {
    if (ctx.hasUI) ui = ctx.ui;
  };

  pi.registerTool({
    name: "wait_for",
    label: "Wait for",
    description:
      "Block until an event happens, then return. The call stays open, so the thread keeps working and the user can press Stop to cancel it. Do NOT end your turn and do NOT poll with sleep or gh loops: when the call returns, go on with the user's instructions (for example rebase after a merge, or report to the user). " +
      "Events: pr.merged (also returns if the PR is closed without merge), pr.checks.done (no check pending; lists failures), pr.review (new review or comment after the wait began; optional reviewer, for example copilot), pr.approved (optional reviewer), time, process.exit (pid, or match: text in the command line of exactly one process this session started), http.ready (first answer with a status below 500). " +
      "PR events poll gh every 30 s and cost no tokens. If the PR already has the review you want, check it with gh first: pr.review only sees NEW activity. The wait ends with the session or a reload.",
    promptGuidelines: [
      "Use wait_for to wait for any event (PR merged, checks, review, approval, timer, process exit, HTTP ready) instead of sleep loops or polling commands. It blocks until the event; then continue the task.",
    ],
    parameters: params,
    async execute(_id, p, signal, _onUpdate, ctx) {
      trackUi(ctx);
      return executeWait(p, envFor(), signal);
    },
  });

  pi.registerTool({
    name: "wait_list",
    label: "List waits",
    description:
      "List active waits made by wait_for and processes this session started that still run.",
    parameters: Type.Object({}),
    async execute() {
      return listWaits(envFor());
    },
  });

  pi.registerTool({
    name: "wait_cancel",
    label: "Cancel wait",
    description: "Cancel an active wait by id (from wait_list). Its wait_for call returns.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, p) {
      return cancelWait(p.id, envFor());
    },
  });
}
