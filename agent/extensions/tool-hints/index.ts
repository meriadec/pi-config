import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AnchorTracker, readNotFoundHint, toAbs } from "./hints.ts";

const NOT_FOUND = /ENOENT|File not found|No such file or directory/i;

interface Part {
  type: string;
  text?: string;
}

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Part[])
        .map((p) => (p.type === "text" && typeof p.text === "string" ? p.text : ""))
        .join("\n")
    : "";

/** Adds a short corrective hint to failing `read` and `edit` results. Never blocks, never throws. */
export default function (pi: ExtensionAPI) {
  const tracker = new AnchorTracker();
  pi.on("tool_result", async (event, ctx) => {
    try {
      const input = (event.input ?? {}) as { path?: unknown };
      const raw = typeof input.path === "string" ? input.path : undefined;
      const path = raw ? toAbs(ctx.cwd, raw) : undefined;
      const text = textOf(event.content);
      tracker.onResult(event.toolName, path, event.isError === true, text);
      if (event.isError !== true) return;
      let hint: string | undefined;
      if (event.toolName === "read" && raw && NOT_FOUND.test(text)) {
        hint = readNotFoundHint(raw, ctx.cwd)?.text;
      } else if (event.toolName === "edit") {
        hint = tracker.hintFor(path, text)?.text;
      }
      if (!hint) return;
      return { content: [...event.content, { type: "text" as const, text: hint }] };
    } catch {
      return;
    }
  });
}
