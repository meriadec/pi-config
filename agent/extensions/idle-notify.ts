import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execFile } from "node:child_process";
import { basename } from "node:path";

const MAX_BODY_LENGTH = 240;

function notify(title: string, body: string) {
	execFile("notify-send", ["-u", "critical", title, body], () => {});
}

function truncate(text: string, maxLength: number) {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
				return String(part.text);
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function lastAssistantText(messages: unknown[]) {
	for (const message of [...messages].reverse()) {
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
		if (!("content" in message)) continue;

		const text = textFromContent(message.content).replace(/\s+/g, " ").trim();
		if (text) return truncate(text, MAX_BODY_LENGTH);
	}

	return "Ready for input";
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_end", async (event, ctx) => {
		// Avoid notifying if queued steering/follow-up messages are still waiting.
		if (ctx.hasPendingMessages()) return;

		const title = pi.getSessionName() || basename(ctx.cwd) || "Pi";
		const body = lastAssistantText(event.messages);

		notify(title, body);
	});
}
