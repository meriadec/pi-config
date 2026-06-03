import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";

const windowId = process.env.WINDOWID;

function setUrgent(urgent: boolean) {
	if (!windowId) return;

	execFile("xdotool", ["set_window", "--urgency", urgent ? "1" : "0", windowId], () => {});
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {
		setUrgent(false);
	});

	pi.on("agent_start", async () => {
		setUrgent(false);
	});

	pi.on("agent_end", async (_event, ctx) => {
		// If steering/follow-up messages are queued, pi is not actually waiting for user input yet.
		if (ctx.hasPendingMessages()) return;

		setUrgent(true);
	});

	pi.on("session_shutdown", async () => {
		setUrgent(false);
	});
}
