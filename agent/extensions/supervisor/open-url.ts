import type { ExecFn } from "./types.ts";

const OPEN_TIMEOUT_MS = 5_000;

const OPENERS: Array<{ command: string; args: string[] }> = [
  { command: "xdg-open", args: [] },
  { command: "open", args: [] },
  { command: "gio", args: ["open"] },
];

export async function openUrl(exec: ExecFn, url: string): Promise<string> {
  const failures: string[] = [];

  for (const opener of OPENERS) {
    const result = await exec(opener.command, [...opener.args, url], { timeout: OPEN_TIMEOUT_MS });
    if (result.code === 0 && !result.killed) return opener.command;

    const detail = (
      result.stderr ||
      result.stdout ||
      (result.killed ? "timed out" : `exit ${result.code}`)
    ).trim();
    failures.push(`${opener.command}: ${detail}`);
  }

  throw new Error(`open failed: ${failures.join("; ")}`);
}
