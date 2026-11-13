import type { Verdict } from "./conditions.ts";

/** Block until a condition is true, the signal aborts, or the check fails too often. */

export type Outcome =
  | { kind: "done"; message: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface UntilDeps {
  /** Resolves after `ms`, or at once when the signal aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const MAX_FAILURES = 5;
export const DEFAULT_RETRY_MS = 30_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

export async function waitUntil(
  check: (signal: AbortSignal) => Promise<Verdict>,
  deps: UntilDeps,
  signal: AbortSignal,
): Promise<Outcome> {
  let failures = 0;
  let delay = DEFAULT_RETRY_MS;
  while (!signal.aborted) {
    try {
      const verdict = await check(signal);
      failures = 0;
      if (verdict.done)
        return signal.aborted ? { kind: "cancelled" } : { kind: "done", message: verdict.message };
      delay = verdict.retryInMs ?? DEFAULT_RETRY_MS;
    } catch (e) {
      if (signal.aborted) break;
      if (++failures >= MAX_FAILURES)
        return {
          kind: "error",
          message: `The check failed ${failures} times in a row. Last error: ${(e as Error).message.slice(0, 300)}`,
        };
      delay = Math.min(DEFAULT_RETRY_MS * 2 ** failures, MAX_BACKOFF_MS);
    }
    await deps.sleep(delay, signal);
  }
  return { kind: "cancelled" };
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}
