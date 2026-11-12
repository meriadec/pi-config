import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadCache } from "./cache.ts";

/** Replace an unchanged repeat `read` result with a short stub. Off unless PI_READ_CACHE=1. */
export default function (pi: ExtensionAPI) {
  const enabled = process.env["PI_READ_CACHE"] === "1";
  let cwd = process.cwd();
  const cache = createReadCache({ cwd: () => cwd });

  pi.registerCommand("read-cache", {
    description: "Show read-cache substitutions",
    handler: async (_args, ctx) => {
      ctx.ui.notify(cache.formatStats(enabled), "info");
    },
  });
  if (!enabled) return;

  pi.on("session_start", async (_e, ctx) => {
    cwd = ctx.cwd;
    cache.reset();
  });
  pi.on("session_compact", async () => cache.reset());
  pi.on("session_tree", async () => cache.reset());
  pi.on("turn_start", async () => cache.onTurnStart());
  pi.on("tool_call", async (event) => {
    cache.onToolCall(event as never);
  });
  pi.on("tool_result", async (event) => cache.onToolResult(event as never) as never);
}
