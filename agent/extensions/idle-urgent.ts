import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setDesktopUrgent } from "./lib/desktopUrgency.ts";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    setDesktopUrgent(false);
  });

  pi.on("agent_start", async () => {
    setDesktopUrgent(false);
  });

  pi.on("agent_end", async (_event, ctx) => {
    // If steering/follow-up messages are queued, pi is not actually waiting for user input yet.
    if (ctx.hasPendingMessages()) return;

    setDesktopUrgent(true);
  });

  pi.on("session_shutdown", async () => {
    setDesktopUrgent(false);
  });
}
