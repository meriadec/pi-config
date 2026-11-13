/** Detects shell commands that poll by hand. Option A: point the agent to a real wait primitive. */
export type PollingKind = "sleep-loop" | "gh-poll" | "watch-cmd" | "long-sleep";

/** Sleeps of this many seconds or more get a hint. Shorter sleeps are normal pauses. */
export const LONG_SLEEP_SECONDS = 20;

// A sleep at the start of a command, after `; & | (`, after `bash -c '`, or after `timeout N`.
const LONG_SLEEP = new RegExp(
  String.raw`(^|[;&|(] ?|\b(ba)?sh -c ['"] ?|\btimeout (?:-\S+ |[A-Z]+ |\d\S* )+)sleep ` +
    String.raw`(([2-9]\d|\d{3,})(\.\d+)?[smhd]?|\d+(\.\d+)?[mhd])\b`,
);

export function detectPolling(command: string): PollingKind | undefined {
  // Text inside a heredoc is file content, not a command.
  const c = command.replace(/<<-?\s*['"]?\w+['"]?[^]*$/, "").replaceAll(/\s+/g, " ");
  if (
    /\b(while|until)\b[^;]*;\s*do\b[^]*\bsleep\b/.test(c) ||
    /\bfor\b[^;]*;\s*do\b[^]*\bsleep\s+\d/.test(c)
  ) {
    return /\bgh (pr|run|api)\b/.test(c) ? "gh-poll" : "sleep-loop";
  }
  if (/\bsleep \d{2,}\b/.test(c) && /\bgh (pr|run|api)\b/.test(c)) return "gh-poll";
  if (LONG_SLEEP.test(c)) return "long-sleep";
  if (/(^|[;&| ])watch (-n ?\d+ )?(gh|curl|kubectl)\b/.test(c)) return "watch-cmd";
  return undefined;
}

export function pollingHint(kind: PollingKind): string {
  return kind === "gh-poll"
    ? "Do not poll GitHub by hand. Call wait_for({event:'pr.review'|'pr.checks', pr}) instead."
    : "Do not poll with sleep. Call wait_for with the event you wait for.";
}
