import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface Part {
  type: string;
  text?: string;
  [k: string]: unknown;
}
interface Stat {
  mtimeMs: number;
  size: number;
}
export type StatFn = (absPath: string) => Stat | undefined;

export interface Substitution {
  path: string;
  turn: number;
  earlierTurn: number;
  bytesSaved: number;
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;
export const MAX_LOG = 50;
export const MAX_ENTRIES = 500;

const defaultStat: StatFn = (p) => {
  try {
    const s = statSync(p);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
};

export const stubText = (earlierTurn: number) =>
  `unchanged since your earlier read (turn ${earlierTurn}); content is above`;

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Session cache of read results: replaces an identical repeat read with a short stub. */
export function createReadCache(opts: { cwd: () => string; stat?: StatFn }) {
  const stat = opts.stat ?? defaultStat;
  let turn = 0;
  let seen = new Map<string, Stat & { turn: number }>();
  let pending = new Map<string, { key: string; stat: Stat | undefined }>();
  let log: Substitution[] = [];
  let count = 0;
  let totalSaved = 0;

  const abs = (p: string) => {
    const clean = p.startsWith("@") ? p.slice(1) : p;
    return isAbsolute(clean) ? clean : resolve(opts.cwd(), clean);
  };
  const keyOf = (input: Record<string, unknown>) => {
    const p = input["path"];
    if (typeof p !== "string" || !p) return undefined;
    return `${abs(p)}\0${String(input["offset"] ?? "")}:${String(input["limit"] ?? "")}`;
  };

  return {
    /** Forget everything: the earlier results may no longer be in the context. */
    reset() {
      seen = new Map();
      pending = new Map();
    },
    onTurnStart() {
      turn++;
    },
    /** Stat before the read runs, so a write racing with the read cannot hide behind the recorded stat. */
    onToolCall(event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) {
      try {
        const p = event.input?.["path"];
        if (typeof p !== "string" || !p) return;
        if (event.toolName === "edit" || event.toolName === "write") {
          const prefix = `${abs(p)}\0`;
          for (const k of seen.keys()) if (k.startsWith(prefix)) seen.delete(k);
          return;
        }
        if (event.toolName !== "read") return;
        const key = keyOf(event.input);
        if (key) pending.set(event.toolCallId, { key, stat: stat(abs(p)) });
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
        if (event.toolName !== "read") return;
        const pend = pending.get(event.toolCallId);
        pending.delete(event.toolCallId);
        if (event.isError) return;
        const path = event.input?.["path"];
        const parts = Array.isArray(event.content) ? event.content : [];
        if (typeof path !== "string" || IMAGE_RE.test(path)) return;
        if (parts.some((p) => p.type !== "text")) return;
        const key = pend?.key ?? keyOf(event.input);
        const st = pend ? pend.stat : stat(abs(path));
        if (!key || !st) return;
        const prev = seen.get(key);
        if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
          const original = parts.map((p) => p.text ?? "").join("");
          const stub = stubText(prev.turn);
          const saved = bytes(original) - bytes(stub);
          if (saved <= 0) return;
          count++;
          totalSaved += saved;
          log.push({ path, turn, earlierTurn: prev.turn, bytesSaved: saved });
          if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
          return { content: [{ type: "text", text: stub }] };
        }
        seen.set(key, { ...st, turn });
        if (seen.size > MAX_ENTRIES) seen.delete(seen.keys().next().value as string);
      } catch {}
      return;
    },
    stats() {
      return { count, totalSaved, entries: seen.size, recent: [...log] };
    },
    formatStats(enabled: boolean) {
      const s = this.stats();
      const lines = [
        `read-cache: ${enabled ? "on" : "off (set PI_READ_CACHE=1)"}; substitutions: ${s.count}; bytes saved: ${s.totalSaved}; cached slices: ${s.entries}`,
      ];
      for (const r of s.recent.slice(-10))
        lines.push(`  turn ${r.turn} <- ${r.earlierTurn}: ${r.path} (-${r.bytesSaved} B)`);
      return lines.join("\n");
    },
  };
}
