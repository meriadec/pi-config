import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLine, bandOf, LOG_PATH, parseMode, parseThreshold, readLines } from "./nudge.ts";

const WOULD = "would suggest /compact or a fresh session; no change made";

/**
 * Context nudge. Shadow (default): logs when context crosses a threshold, changes nothing.
 * Notify: also shows one short notice per session. Never compacts, never edits model context.
 */
export default function (pi: ExtensionAPI) {
  let lastBand = -1;
  let notified = false;
  const logPath = () => process.env["PI_CONTEXT_NUDGE_LOG"] || LOG_PATH;
  const sessionFile = (ctx: any): string => {
    try {
      return ctx.sessionManager?.getSessionFile?.() ?? "ephemeral";
    } catch {
      return "ephemeral";
    }
  };
  const reset = () => {
    lastBand = -1;
    notified = false;
  };

  pi.on("session_start", async () => {
    reset();
  });
  pi.on("session_shutdown", async () => {
    reset();
  });

  pi.on("turn_end", async (_event, ctx) => {
    try {
      const mode = parseMode(process.env["PI_CONTEXT_NUDGE"]);
      if (mode === "off") return;
      const threshold = parseThreshold(process.env["PI_CONTEXT_NUDGE_TOKENS"]);
      const tokens = ctx.getContextUsage()?.tokens;
      if (typeof tokens !== "number") return;
      const band = bandOf(tokens, threshold);
      if (band <= lastBand) return;
      lastBand = band;
      let turns = 0;
      let cost = 0;
      let haveCost = false;
      for (const e of ctx.sessionManager.getBranch() as any[]) {
        const m = e?.message;
        if (e?.type !== "message" || m?.role !== "assistant") continue;
        turns++;
        const c = m.usage?.cost?.total;
        if (typeof c === "number") {
          cost += c;
          haveCost = true;
        }
      }
      appendLine(logPath(), {
        ts: new Date().toISOString(),
        session: sessionFile(ctx),
        model: ctx.model?.id ?? "unknown",
        tokens,
        threshold,
        band,
        turns,
        cost: haveCost ? cost : null,
        mode,
        wouldDo: WOULD,
      });
      if (mode === "notify" && !notified && ctx.hasUI) {
        notified = true;
        ctx.ui.notify(
          `Context is large (${Math.round(tokens / 1000)}K tokens). Consider /compact.`,
          "warning",
        );
      }
    } catch {
      // fail open
    }
  });

  pi.registerCommand("context-nudge", {
    description: "Show context-nudge mode, threshold and this session's log lines",
    handler: async (_args, ctx) => {
      let text: string;
      try {
        const file = sessionFile(ctx);
        const mine = readLines(logPath()).filter((l) => l["session"] === file);
        text = [
          `mode: ${parseMode(process.env["PI_CONTEXT_NUDGE"])}`,
          `threshold: ${parseThreshold(process.env["PI_CONTEXT_NUDGE_TOKENS"])} tokens`,
          `log lines for this session: ${mine.length}`,
          ...mine.map((l) => JSON.stringify(l)),
        ].join("\n");
      } catch {
        text = "context-nudge: could not read state";
      }
      try {
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else console.log(text);
      } catch {
        // fail open
      }
    },
  });
}
