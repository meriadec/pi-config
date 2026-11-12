#!/usr/bin/env bun
/**
 * Replay the tool-hints rules over every failing `read` and `edit` result in history.
 * Prints how many failures each rule would have matched, per failure class.
 * Read hints use the CURRENT file system (past worktrees are mostly gone), so the
 * "similar-name" count is a lower bound; the kind split is what matters.
 * Usage: bun analytics/tool-hints-replay.ts
 */
import { readFileSync } from "node:fs";
import { classifyFailure } from "./classify.ts";
import { openSessions, rows } from "./db.ts";
import { AnchorTracker, readNotFoundHint, toAbs } from "../agent/extensions/tool-hints/hints.ts";

interface Counter {
  total: number;
  matched: number;
  kinds: Map<string, number>;
  maxBytes: number;
}
const counters = new Map<string, Counter>();
function bump(cls: string, kind: string | undefined, text?: string) {
  const c = counters.get(cls) ?? { total: 0, matched: 0, kinds: new Map(), maxBytes: 0 };
  c.total++;
  if (kind) {
    c.matched++;
    c.kinds.set(kind, (c.kinds.get(kind) ?? 0) + 1);
    c.maxBytes = Math.max(c.maxBytes, Buffer.byteLength(text ?? ""));
  }
  counters.set(cls, c);
}

const cwdOf = (file: string) => {
  try {
    return (
      (JSON.parse(readFileSync(file, "utf8").slice(0, 4000).split("\n")[0] ?? "{}")
        .cwd as string) ?? "/"
    );
  } catch {
    return "/";
  }
};
const esc = (s: string) => s.replaceAll("'", "''");

const db = await openSessions();

// 1. read: not found
const reads = await rows<{
  file: string;
  call_id: string;
  head: string;
  tail: string;
  path: string | null;
}>(
  db,
  `select r.file, r.call_id, r.head, r.tail, c.args->>'path' path
   from tool_results r join tool_calls c on c.file = r.file and c.call_id = r.call_id
   where r.is_error and r.tool = 'read'`,
);
const cwds = new Map<string, string>();
for (const r of reads) {
  if (classifyFailure("read", r.head, r.tail) !== "path-not-found" || !r.path) continue;
  if (!cwds.has(r.file)) cwds.set(r.file, cwdOf(r.file));
  const hint = readNotFoundHint(r.path, cwds.get(r.file) ?? "/");
  bump("read:path-not-found", hint?.kind, hint?.text);
}

// 2. edit: anchor errors, replaying the tracker in message order per session
const anchorFiles = await rows<{ file: string }>(
  db,
  `select distinct file from tool_results where is_error and tool = 'edit'
   and (head like '%E_STALE_ANCHOR%' or head like '%E_BAD_REF%')`,
);
for (const { file } of anchorFiles) {
  const f = esc(file);
  const paths = new Map(
    (
      await rows<{ call_id: string; path: string | null }>(
        db,
        `select call_id, args->>'path' path from tool_calls where file = '${f}'`,
      )
    ).map((r) => [r.call_id, r.path]),
  );
  const results = await rows<{ call_id: string; tool: string; is_error: boolean; t: string }>(
    db,
    `select message->>'toolCallId' call_id, message->>'toolName' tool,
       coalesce((message->>'isError')::boolean, false) is_error, message->>'content' t
     from messages where file = '${f}' and message->>'role' = 'toolResult'
       and message->>'toolName' in ('read', 'grep', 'edit', 'write') order by ts`,
  );
  const cwd = cwdOf(file);
  const tracker = new AnchorTracker();
  for (const r of results) {
    const raw = paths.get(r.call_id);
    const path = raw ? toAbs(cwd, raw) : undefined;
    const text = r.t.replaceAll("\\n", "\n");
    if (
      r.tool === "edit" &&
      r.is_error &&
      classifyFailure("edit", r.t.slice(0, 600), r.t.slice(-300)) === "edit-bad-anchor"
    ) {
      const hint = tracker.hintFor(path, text);
      bump("edit:edit-bad-anchor", hint?.kind, hint?.text);
    }
    tracker.onResult(r.tool, path, r.is_error, text);
  }
}

console.log(
  "class".padEnd(24),
  "failures".padStart(8),
  "matched".padStart(8),
  "max-bytes".padStart(10),
  "kinds",
);
for (const [cls, c] of [...counters].sort()) {
  const kinds = [...c.kinds].map(([k, n]) => `${k}=${n}`).join(" ");
  console.log(
    cls.padEnd(24),
    String(c.total).padStart(8),
    String(c.matched).padStart(8),
    String(c.maxBytes).padStart(10),
    kinds,
  );
}
