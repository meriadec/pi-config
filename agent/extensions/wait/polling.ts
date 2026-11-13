/** Detects shell commands that poll by hand. Option A: point the agent to a real wait primitive. */
export type PollingKind = "sleep-loop" | "gh-poll" | "watch-cmd" | "long-sleep" | "startup-pause";

/** Sleeps of this many seconds or more get a hint. Shorter sleeps are normal pauses. */
export const LONG_SLEEP_SECONDS = 20;

// A sleep at the start of a command, after `; & | (`, after `bash -c '`, or after `timeout N`.
const LONG_SLEEP = new RegExp(
  String.raw`(^|[;&|(] ?|\b(ba)?sh -c ['"] ?|\btimeout (?:-\S+ |[A-Z]+ |\d\S* )+)sleep ` +
    String.raw`(([2-9]\d|\d{3,})(\.\d+)?[smhd]?|\d+(\.\d+)?[mhd])\b`,
);

// The same command starts a background process: `(server &); sleep 25; curl ...`.
const BACKGROUND_START = /(?:\s&(?!&)|\bnohup\b|\bsetsid\b|\bdisown\b)/;

/** A loop that is bounded by `timeout` and sleeps 5 s or less per round is a normal readiness check. */
function isBoundedShortLoop(c: string): boolean {
  if (!/\btimeout\b/.test(c)) return false;
  const sleeps = [...c.matchAll(/\bsleep (\d+(?:\.\d+)?)\b/g)].map((m) => Number(m[1]));
  return sleeps.length > 0 && sleeps.every((n) => n <= 5);
}

export function detectPolling(command: string): PollingKind | undefined {
  // Text inside a heredoc is file content, not a command.
  const c = command.replace(/<<-?\s*['"]?\w+['"]?[^]*$/, "").replaceAll(/\s+/g, " ");
  if (
    /\b(while|until)\b[^;]*;\s*do\b[^]*\bsleep\b/.test(c) ||
    /\bfor\b[^;]*;\s*do\b[^]*\bsleep\s+\d/.test(c)
  ) {
    if (/\bgh (pr|run|api)\b/.test(c)) return "gh-poll";
    return isBoundedShortLoop(c) ? undefined : "sleep-loop";
  }
  if (/\bsleep \d{2,}\b/.test(c) && /\bgh (pr|run|api)\b/.test(c)) return "gh-poll";
  if (LONG_SLEEP.test(c)) return BACKGROUND_START.test(c) ? "startup-pause" : "long-sleep";
  if (/(^|[;&| ])watch (-n ?\d+ )?(gh|curl|kubectl)\b/.test(c)) return "watch-cmd";
  return undefined;
}

export function pollingHint(kind: PollingKind): string {
  if (kind === "gh-poll") {
    return "Do not poll GitHub by hand. Call wait_for({event:'pr.merged'|'pr.checks.done'|'pr.review'|'pr.approved', pr}); it blocks until the event.";
  }
  if (kind === "startup-pause") {
    return "A fixed pause after a background start is fragile. Call wait_for({event:'http.ready', url}), or use a bounded loop: timeout 60 bash -c 'until curl -sf URL; do sleep 1; done'.";
  }
  return "Do not poll with sleep. Call wait_for with the event you wait for.";
}
