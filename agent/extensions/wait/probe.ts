/** Real probes for the local runner. Kept apart so tests can use them against a real server. */

/** True when the URL answers once with a status below 500. One answer is enough: no retry, no body check. */
export async function httpUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
