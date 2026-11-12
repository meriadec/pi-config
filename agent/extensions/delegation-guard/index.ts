import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { appendRecord } from "../context-guard/log.ts";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DELEGATE_TOOLS,
  DelegationState,
  FOLLOW_TOOLS,
  parseMax,
  parseMode,
  shortName,
  type Mode,
  type Rec,
} from "./rules.ts";

export const LOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../analytics/data/delegation.jsonl",
);

export interface HookOptions {
  mode: Mode;
  max: number;
  /** Receives one record. Default: append to the JSONL log. */
  log?: (record: Rec) => void;
  sendMessage?: (message: { customType: string; content: string }) => void;
}

const textOf = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
};

/** Hook functions. Every one fails open: an error never blocks and never throws. */
export function createHooks(opts: HookOptions) {
  let sessionId = randomBytes(6).toString("hex");
  let state = new DelegationState(opts);
  const write = (r: Rec) => {
    const rec = { session: sessionId, ...r };
    if (opts.log) opts.log(rec);
    else appendRecord(rec, LOG_PATH);
  };

  return {
    start() {
      sessionId = randomBytes(6).toString("hex");
      state = new DelegationState(opts);
    },

    onToolCall(event: {
      toolName: string;
      toolCallId: string;
      input: unknown;
    }): { block: true; reason: string } | undefined {
      try {
        if (opts.mode === "off") return;
        const tool = shortName(event.toolName);
        if ((FOLLOW_TOOLS as readonly string[]).includes(tool)) {
          state.onFollowup(tool, event.input).forEach(write);
          return;
        }
        if (!(DELEGATE_TOOLS as readonly string[]).includes(tool)) return;
        const { records, block } = state.onCall(event.toolCallId, tool, event.input);
        records.forEach(write);
        if (block && opts.mode === "live") return { block: true as const, reason: block.reason };
      } catch {
        return;
      }
      return undefined;
    },

    onToolResult(event: {
      toolName: string;
      toolCallId: string;
      content: unknown;
      isError?: boolean;
    }) {
      try {
        if (opts.mode === "off") return;
        const tool = shortName(event.toolName);
        if (!(DELEGATE_TOOLS as readonly string[]).includes(tool)) return;
        state
          .onResult(event.toolCallId, tool, textOf(event.content), event.isError === true)
          .forEach(write);
      } catch {
        return;
      }
    },

    onAgentEnd() {
      try {
        if (opts.mode === "off") return;
        const { records, message } = state.onAgentEnd();
        records.forEach(write);
        if (message) opts.sendMessage?.({ customType: "delegation-orphans", content: message });
      } catch {
        return;
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const mode = parseMode(process.env["PI_DELEGATION_GUARD"]);
  if (mode === "off") return;
  const hooks = createHooks({
    mode,
    max: parseMax(process.env["PI_DELEGATION_MAX"]),
    sendMessage: (m) => pi.sendMessage({ ...m, display: true, details: {} }),
  });
  pi.on("session_start", async () => hooks.start());
  pi.on("tool_call", async (event) => hooks.onToolCall(event as never) as never);
  pi.on("tool_result", async (event) => {
    hooks.onToolResult(event as never);
  });
  pi.on("agent_end", async () => hooks.onAgentEnd());
}
