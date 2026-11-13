import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Env var set on the Pi process. Every shell command inherits it, so we can find leftovers later. */
export const SESSION_TAG_ENV = "PI_WAIT_SESSION";

export interface TaggedProcess {
  pid: number;
  ppid: number;
  ageSeconds: number;
  command: string;
}

export const SCAN_MAX_INSPECTED = 2_000;
export const SCAN_MAX_REPORTED = 20;
export const SCAN_BUDGET_MS = 1_500;

export function hasTag(environ: string, sessionId: string): boolean {
  return environ.split("\0").includes(`${SESSION_TAG_ENV}=${sessionId}`);
}

/** Parse `ps -o pid=,ppid=,etimes=,args=` output. */
export function parsePs(output: string): TaggedProcess[] {
  const out: TaggedProcess[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m)
      out.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        ageSeconds: Number(m[3]),
        command: (m[4] ?? "").slice(0, 160),
      });
  }
  return out;
}

export interface ScanOptions {
  maxInspected?: number;
  maxReported?: number;
  budgetMs?: number;
  /** Test seams. Defaults: `ps -u <uid>` and `/proc/<pid>/environ`. */
  listPs?: () => Promise<string>;
  readEnviron?: (pid: number) => Promise<string>;
  now?: () => number;
}

async function psOfCurrentUser(budgetMs: number): Promise<string> {
  const uid = process.getuid?.() ?? 0;
  const { stdout } = await run("ps", ["-u", String(uid), "-o", "pid=,ppid=,etimes=,args="], {
    timeout: budgetMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

/**
 * Processes of the current user that carry this session's tag, minus Pi itself and the scan.
 * Linux only: reads /proc. Bounded: at most `maxInspected` processes are read, at most
 * `maxReported` are returned, and the scan stops after `budgetMs` and returns what it has.
 */
export async function findTagged(
  sessionId: string,
  minAgeSeconds: number,
  opts: ScanOptions = {},
): Promise<TaggedProcess[]> {
  const maxInspected = opts.maxInspected ?? SCAN_MAX_INSPECTED;
  const maxReported = opts.maxReported ?? SCAN_MAX_REPORTED;
  const budgetMs = opts.budgetMs ?? SCAN_BUDGET_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  const readEnviron =
    opts.readEnviron ?? ((pid: number) => readFile(`/proc/${pid}/environ`, "utf8"));
  const all = parsePs(await (opts.listPs ?? (() => psOfCurrentUser(budgetMs)))());
  const found: TaggedProcess[] = [];
  let inspected = 0;
  for (const p of all) {
    if (inspected >= maxInspected || found.length >= maxReported) break;
    if (now() - started >= budgetMs) break;
    if (p.pid === process.pid || p.ageSeconds < minAgeSeconds || /^ps\b/.test(p.command)) continue;
    inspected++;
    const environ = await readEnviron(p.pid).catch(() => "");
    if (hasTag(environ, sessionId)) found.push(p);
  }
  return found;
}

export type MatchResult =
  | { ok: true; process: TaggedProcess }
  | { ok: false; error: string; candidates: TaggedProcess[] };

const shorten = (c: string, n = 80) => (c.length > n ? `${c.slice(0, n - 1)}…` : c);

/**
 * Pick the one tagged process whose command line contains `match`. A shell that only wraps a
 * matching child is dropped, so `bash -c "pnpm dev"` and its child count once.
 */
export function pickByMatch(procs: TaggedProcess[], match: string): MatchResult {
  const hits = procs.filter((p) => p.command.includes(match));
  const parents = new Set(hits.map((p) => p.ppid));
  const leaves = hits.filter((p) => !parents.has(p.pid));
  const [only] = leaves;
  if (leaves.length === 1 && only) return { ok: true, process: only };
  const list = leaves
    .slice(0, 5)
    .map((p) => `pid ${p.pid}: ${shorten(p.command)}`)
    .join("; ");
  const error =
    leaves.length === 0
      ? `no process started in this session has "${match}" in its command line. Use pid instead.`
      : `${leaves.length} processes match "${match}"; use a longer match or pid. Candidates: ${list}${leaves.length > 5 ? "; …" : ""}`;
  return { ok: false, error, candidates: leaves.slice(0, 5) };
}

export function describeLeftovers(procs: TaggedProcess[]): string {
  if (procs.length === 0) return "";
  const lines = procs.map(
    (p) => `- pid ${p.pid}, up ${Math.max(1, Math.round(p.ageSeconds / 60))} min: ${p.command}`,
  );
  return `${procs.length} process(es) started in this session still run:\n${lines.join("\n")}\nStop them if no longer needed.`;
}
