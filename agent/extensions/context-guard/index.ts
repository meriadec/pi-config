import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { appendRecord, LOG_PATH, newSessionId, parseMode, type GuardMode } from "./log.ts";
import { quietSuccess } from "./quiet.ts";
import { ReadTracker } from "./reread.ts";
import { byteLength, DEFAULT_CAP_BYTES, reduceOutput, removedBytes } from "./reduce.ts";

/** Command families (first two words) that the cap must skip. */
export const NEVER_CAP: string[] = [];

/** Result text under this size is cheaper to re-read than to explain. */
export const REREAD_MIN_BYTES = 1_500;
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const KEEP_BASENAMES = new Set([
  "AGENTS.md",
  "CONTEXT.md",
  "GLOSSARY.md",
  "SKILL.md",
  "README.md",
  "package.json",
]);

/** Privacy: the extension, or the basename for a few known doc names. Never a directory. */
export const pathExt = (path: string) => {
  const name = basename(path);
  return KEEP_BASENAMES.has(name) ? name : extname(name).toLowerCase().slice(0, 12);
};

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
const CD_PREFIX = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;
const ENV_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/;

/** First two words of the first real command. Skips `cd <dir> &&` and `FOO=1` prefixes. */
export const commandFamily = (cmd: string) => {
  let rest = cmd.trim();
  for (;;) {
    const next = rest.replace(CD_PREFIX, "").replace(ENV_PREFIX, "");
    if (next === rest) break;
    rest = next;
  }
  const segment = rest.split(/&&|\|\||[;|\n]/)[0] ?? "";
  return segment.trim().split(/\s+/).slice(0, 2).join(" ").slice(0, 60);
};

export function createGuard(opts: GuardOptions) {
  const cap = opts.capBytes ?? DEFAULT_CAP_BYTES;
  const logPath = opts.logPath ?? LOG_PATH;
  const spillDir = opts.spillDir ?? SPILL_DIR;
  let sessionId = newSessionId();
  let overCap = new Map<string, string>(); // command hash -> family
  let spills = new Map<string, { hash: string; family: string }>();
  const tracker = new ReadTracker();
  let turn = 0;
  let blockedReads = new Set<string>(); // per-path counter: one block, then let the repeat through

  /** Resolve the read path and stat it. Undefined when skipped or when stat fails. */
  function readTarget(input: Record<string, unknown>, cwd: string) {
    try {
      const raw = input?.["path"];
      if (typeof raw !== "string" || !raw) return;
      let p = raw.startsWith("@") ? raw.slice(1) : raw;
      if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
      const path = isAbsolute(p) ? p : resolve(cwd, p);
      if (IMAGE_EXT.has(extname(path).toLowerCase())) return;
      const st = statSync(path);
      if (!st.isFile()) return;
      const num = (v: unknown) => (typeof v === "number" ? v : undefined);
      return {
        path,
        mtimeMs: st.mtimeMs,
        size: st.size,
        offset: num(input["offset"]),
        limit: num(input["limit"]),
      };
    } catch {
      return;
    }
  }

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
      tracker.reset();
      blockedReads = new Set();
      turn = 0;
      if (opts.mode === "live") cleanOldSpills();
    },

    onTurn() {
      turn++;
    },

    /** Compaction removed old results from context: forget all reads. */
    onCompact() {
      tracker.reset();
      blockedReads = new Set();
    },

    /** Check a read before it runs. Returns a block in live mode only. */
    onReadCall(
      event: { toolName: string; input: Record<string, unknown> },
      cwd: string,
    ): { block: true; reason: string } | undefined {
      try {
        if (opts.mode === "off" || event.toolName !== "read") return;
        const t = readTarget(event.input, cwd);
        if (!t) return;
        const hit = tracker.check(t.path, t);
        const k = JSON.stringify([t.path, t.offset ?? null, t.limit ?? null]);
        if (!hit) {
          blockedReads.delete(k);
          return;
        }
        const turnsSince = turn - hit.firstTurn;
        log({
          tool: "read",
          rule: "reread",
          path_ext: pathExt(t.path),
          bytes: hit.bytes,
          turnsSince,
          ...(opts.mode === "live" ? { blocked: !blockedReads.has(k) } : {}),
        });
        if (opts.mode !== "live") return;
        if (blockedReads.has(k)) {
          blockedReads.delete(k); // the model insists: let it through
          return;
        }
        blockedReads.add(k);
        return {
          block: true,
          reason: `File unchanged since your read at turn ${hit.firstTurn} (${hit.bytes} bytes). Use the earlier result, or read a different slice.`,
        };
      } catch {
        return;
      }
    },

    /** Record a successful read so a later identical read can be detected. */
    onReadResult(
      event: {
        toolName: string;
        input: Record<string, unknown>;
        content: Part[];
        isError?: boolean | undefined;
      },
      cwd: string,
    ) {
      try {
        if (opts.mode === "off" || event.toolName !== "read" || event.isError !== false) return;
        const parts = Array.isArray(event.content) ? event.content : [];
        const texts = parts.filter((p) => p.type === "text" && typeof p.text === "string");
        if (texts.length === 0) return;
        const bytes = byteLength(texts.map((p) => p.text).join("\n"));
        if (bytes < REREAD_MIN_BYTES) return;
        const t = readTarget(event.input, cwd);
        if (!t) return;
        tracker.record(t.path, { ...t, turn, bytes });
      } catch {}
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
      isError?: boolean | undefined;
    }): { content: Part[] } | undefined {
      try {
        if (opts.mode === "off" || event.toolName !== "bash") return;
        const parts = Array.isArray(event.content) ? event.content : [];
        const textParts = parts.filter((p) => p.type === "text" && typeof p.text === "string");
        const originalText = textParts.map((p) => p.text).join("\n");
        const command = typeof event.input?.["command"] === "string" ? event.input["command"] : "";
        let text = originalText;
        let quietApplied = false;
        // Quiet rule: only for a successful result (isError === false, no exit-code text).
        if (event.isError === false && !originalText.includes("Command exited with code")) {
          const q = quietSuccess(command, originalText);
          if (q) {
            quietApplied = true;
            text = q.text;
            log({
              toolCallId: event.toolCallId,
              tool: event.toolName,
              family: commandFamily(command),
              cmdSha1: sha1(command),
              bytes: byteLength(originalText),
              removed: q.removedBytes,
              rule: "quiet",
            });
          }
        }
        const others = parts.filter((p) => !(p.type === "text" && typeof p.text === "string"));
        const quietResult = () =>
          quietApplied && opts.mode === "live"
            ? { content: [{ type: "text", text }, ...others] }
            : undefined;
        const bytes = byteLength(text);
        if (bytes <= cap) return quietResult();
        const family = commandFamily(command);
        if (NEVER_CAP.includes(family)) return quietResult();
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
          return quietResult();
        }
        const safeId = event.toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
        const file = join(spillDir, `${sessionId}-${safeId}.txt`);
        mkdirSync(spillDir, { recursive: true, mode: 0o700 });
        writeFileSync(file, originalText, { mode: 0o600 });
        const reduced = reduceOutput(text, cap, file);
        overCap.set(hash, family);
        spills.set(file, { hash, family });
        log(record);
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
  pi.on("session_tree", async () => guard.onCompact());
  pi.on("session_compact", async () => guard.onCompact());
  pi.on("turn_start", async () => guard.onTurn());
  pi.on("tool_call", async (event, ctx) => {
    guard.onToolCall(event as never);
    return guard.onReadCall(event as never, ctx.cwd) as never;
  });
  pi.on("tool_result", async (event, ctx) => {
    guard.onReadResult(event as never, ctx.cwd);
    return guard.onToolResult(event as never) as never;
  });
}
