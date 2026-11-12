import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Env var set on the Pi process. Every shell command inherits it, so we can find leftovers later. */
export const SESSION_TAG_ENV = "PI_WAIT_SESSION";

export interface TaggedProcess {
  pid: number;
  ageSeconds: number;
  command: string;
}

export function hasTag(environ: string, sessionId: string): boolean {
  return environ.split("\0").includes(`${SESSION_TAG_ENV}=${sessionId}`);
}

/** Parse `ps -eo pid=,etimes=,args=` output. */
export function parsePs(output: string): TaggedProcess[] {
  const out: TaggedProcess[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m)
      out.push({
        pid: Number(m[1]),
        ageSeconds: Number(m[2]),
        command: (m[3] ?? "").slice(0, 160),
      });
  }
  return out;
}

/** Processes that carry this session's tag, minus Pi itself and the scan. Linux only: reads /proc. */
export async function findTagged(
  sessionId: string,
  minAgeSeconds: number,
): Promise<TaggedProcess[]> {
  const { stdout } = await run("ps", ["-eo", "pid=,etimes=,args="]);
  const found: TaggedProcess[] = [];
  for (const p of parsePs(stdout)) {
    if (p.pid === process.pid || p.ageSeconds < minAgeSeconds) continue;
    const environ = await readFile(`/proc/${p.pid}/environ`, "utf8").catch(() => "");
    if (hasTag(environ, sessionId)) found.push(p);
  }
  return found;
}

export function describeLeftovers(procs: TaggedProcess[]): string {
  if (procs.length === 0) return "";
  const lines = procs.map(
    (p) => `- pid ${p.pid}, up ${Math.max(1, Math.round(p.ageSeconds / 60))} min: ${p.command}`,
  );
  return `${procs.length} process(es) started in this session still run:\n${lines.join("\n")}\nStop them if no longer needed.`;
}
