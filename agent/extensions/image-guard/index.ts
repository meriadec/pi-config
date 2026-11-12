import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageGuard, DEFAULT_THRESHOLD, magickResizer } from "./guard.ts";

/** Downscale large images in tool results to 1024 px long side (ImageMagick). Off unless PI_IMAGE_GUARD=1. */
export default function (pi: ExtensionAPI) {
  const enabled = process.env["PI_IMAGE_GUARD"] === "1";
  const threshold = Number(process.env["PI_IMAGE_GUARD_THRESHOLD"]) || DEFAULT_THRESHOLD;
  const guard = createImageGuard({ resize: magickResizer(), threshold });

  pi.registerCommand("image-guard", {
    description: "Show image-guard counters",
    handler: async (_args, ctx) => {
      ctx.ui.notify(guard.format(enabled), "info");
    },
  });
  if (!enabled) return;
  pi.on("tool_result", async (event) => (await guard.onToolResult(event as never)) as never);
}
