import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRecord, LOG_PATH, newSessionId, parseMode, type GuardMode } from "./log.ts";
import { byteLength, DEFAULT_CAP_BYTES, reduceOutput, removedBytes } from "./reduce.ts";

/** Command families (first two words) that the cap must skip. */
export const NEVER_CAP: string[] = [];

export const SPILL_DIR = "/tmp/pi-out";
const SPILL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export interface GuardOptions {
  mode: GuardMode;
  capBytes?: number;
  logPath?: string;
  spillDir?: string;
}

interface Part {
  type: string;
  text?: string;
  [k: string]: unknown;
}

export const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
export const commandFamily = (cmd: string) =>
  cmd.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 60);

export function createGuard(opts: GuardOptions) {
  const cap = opts.capBytes ?? DEFAULT_CAP_BYTES;
  const logPath = opts.logPath ?? LOG_PATH;
  const spillDir = opts.spillDir ?? SPILL_DIR;
  let sessionId = newSessionId();
  let overCap = new Map<string, string>(); // command hash -> family
  let spills = new Map<string, { hash: string; family: string }>();

  const log = (r: Record<string, unknown>) => appendRecord({ session: sessionId, ...r }, logPath);

  function cleanOldSpills() {
    try {
      const now = Date.now();
      for (const name of readdirSync(spillDir)) {
        try {
          const p = join(spillDir, name);
          if (now - statSync(p).mtimeMs > SPILL_MAX_AGE_MS) unlinkSync(p);
        } catch {}
      }
    } catch {}
  }

  return {
    start() {
      sessionId = newSessionId();
      overCap = new Map();
      spills = new Map();
      if (opts.mode === "live") cleanOldSpills();
    },

    onToolCall(event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) {
      try {
        if (opts.mode === "off") return;
        const command = typeof event.input?.["command"] === "string" ? event.input["command"] : "";
        const path = typeof event.input?.["path"] === "string" ? event.input["path"] : "";
        const subject = event.toolName === "bash" ? command : event.toolName === "read" ? path : "";
        if (!subject) return;
        const base = { toolCallId: event.toolCallId, tool: event.toolName, rule: "refetch" };
        for (const [spillPath, info] of spills) {
          if (subject.includes(spillPath)) {
            log({ ...base, family: info.family, cmdSha1: info.hash, via: "spill" });
            return;
          }
        }
        if (subject.includes(`${spillDir}/`)) {
          log({ ...base, family: commandFamily(subject), cmdSha1: sha1(subject), via: "spill" });
          return;
        }
        if (event.toolName !== "bash") return;
        const hash = sha1(command);
        const family = overCap.get(hash);
        if (family !== undefined) log({ ...base, family, cmdSha1: hash, via: "command" });
      } catch {}
    },

    onToolResult(event: {
      toolName: string;
      toolCallId: string;
      input: Record<string, unknown>;
      content: Part[];
    }): { content: Part[] } | undefined {
      try {
        if (opts.mode === "off" || event.toolName !== "bash") return;
        const parts = Array.isArray(event.content) ? event.content : [];
        const textParts = parts.filter((p) => p.type === "text" && typeof p.text === "string");
        const text = textParts.map((p) => p.text).join("\n");
        const bytes = byteLength(text);
        if (bytes <= cap) return;
        const command = typeof event.input?.["command"] === "string" ? event.input["command"] : "";
        const family = commandFamily(command);
        if (NEVER_CAP.includes(family)) return;
        const hash = sha1(command);
        const removed = removedBytes(text, cap);
        const record = {
          toolCallId: event.toolCallId,
          tool: event.toolName,
          family,
          cmdSha1: hash,
          bytes,
          removed,
          rule: "cap",
        };
        if (opts.mode === "shadow") {
          overCap.set(hash, family);
          log(record);
          return;
        }
        const safeId = event.toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
        const file = join(spillDir, `${sessionId}-${safeId}.txt`);
        mkdirSync(spillDir, { recursive: true, mode: 0o700 });
        writeFileSync(file, text, { mode: 0o600 });
        const reduced = reduceOutput(text, cap, file);
        overCap.set(hash, family);
        spills.set(file, { hash, family });
        log(record);
        const others = parts.filter((p) => !(p.type === "text" && typeof p.text === "string"));
        return { content: [{ type: "text", text: reduced }, ...others] };
      } catch {
        return;
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const mode = parseMode(process.env["PI_CONTEXT_GUARD"]);
  if (mode === "off") return;
  const guard = createGuard({ mode });
  pi.on("session_start", async () => guard.start());
  pi.on("tool_call", async (event) => {
    guard.onToolCall(event as never);
  });
  pi.on("tool_result", async (event) => guard.onToolResult(event as never) as never);
}
