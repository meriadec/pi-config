/** Failure taxonomy for tool results. Pure: same input, same class. */

export type FailureClass =
  | "edit-schema-invalid"
  | "edit-bad-anchor"
  | "edit-multi-match"
  | "edit-would-empty"
  | "edit-conflict"
  | "edit-empty-request"
  | "edit-no-match"
  | "edit-bad-op"
  | "read-misuse"
  | "shell-syntax"
  | "script-error"
  | "path-not-found"
  | "sandbox-capability"
  | "network-or-5xx"
  | "t3-task-not-found"
  | "aborted"
  | "timeout"
  | "command-not-found"
  | "permission"
  | "browser-launch"
  | "empty-result-exit1" // typically grep/rg with no match: benign
  | "killed-sigterm"
  | "check-failed" // lint, typecheck or test run exited non-zero: expected feedback
  | "git-remote-rejected"
  | "exit-nonzero-other"
  | "unknown";

/** Classes that mean the agent or its tools misbehaved, not that the code under work is wrong. */
export const TOOLING_CLASSES: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "edit-schema-invalid",
  "edit-bad-anchor",
  "edit-multi-match",
  "edit-would-empty",
  "edit-conflict",
  "edit-empty-request",
  "edit-no-match",
  "edit-bad-op",
  "read-misuse",
  "shell-syntax",
  "path-not-found",
  "sandbox-capability",
  "command-not-found",
  "browser-launch",
  "t3-task-not-found",
]);

const CHECK_RUNNERS =
  /(?:^|"text":")\$ (tsgo|tsc|biome|eslint|oxlint|oxfmt|vitest|jest|bun (run )?(test|typecheck|lint|check)|pnpm (run )?(test|lint|check|typecheck)|nx |turbo )/;

export function classifyFailure(tool: string, head: string, tail = head): FailureClass {
  const all = `${head}\n${tail}`;
  if (tool === "edit" || tool === "write") {
    if (/Validation failed for tool/.test(all)) return "edit-schema-invalid";
    if (/E_BAD_REF|E_STALE_ANCHOR/.test(all)) return "edit-bad-anchor";
    if (/E_MULTI_MATCH|Found \d+ occurrences of edits/.test(all)) return "edit-multi-match";
    if (/E_NO_MATCH|Could not find (the exact text|edits\[)/.test(all)) return "edit-no-match";
    if (/E_BAD_OP/.test(all)) return "edit-bad-op";
    if (/E_WOULD_EMPTY/.test(all)) return "edit-would-empty";
    if (/E_EDIT_CONFLICT/.test(all)) return "edit-conflict";
    if (/Edit request requires/.test(all)) return "edit-empty-request";
  }
  if (tool === "read" && /EISDIR|is beyond end of file/.test(all)) return "read-misuse";
  if (tool === "bash" && /unexpected EOF|syntax error near/.test(all)) return "shell-syntax";
  if (/ENOENT|File not found|No such file or directory/i.test(all)) return "path-not-found";
  if (/is not defined/.test(all) && tool === "codemode") return "sandbox-capability";
  if (/task_not_found/.test(all)) return "t3-task-not-found";
  if (/Command aborted|aborted/i.test(tail)) return "aborted";
  if (/timed out|ETIMEDOUT|timeout/i.test(all)) return "timeout";
  if (/command not found|not recognized as/i.test(all)) return "command-not-found";
  if (/Permission denied|EACCES|Forbidden/i.test(all)) return "permission";
  if (/Chrome exited early|Auto-launch failed/.test(all)) return "browser-launch";
  if (/fetch failed|ECONNREFUSED|Could not resolve host|\(5\d\d\)|\b50[0-4]\b/.test(all)) {
    return "network-or-5xx";
  }
  if (/^remote: |! \[remote rejected\]/m.test(all)) return "git-remote-rejected";
  if (tool === "bash" && /\(no output\)(?:\s|\\n)+Command exited with code 1\b/.test(all))
    return "empty-result-exit1";
  if (tool === "bash" && /Command exited with code 143/.test(all)) return "killed-sigterm";
  if (tool === "bash" && /lefthook|ERR_PNPM|Cannot find module|bun test v|CSpell/.test(head))
    return "check-failed";
  if (tool === "bash" && /Traceback \(most recent call last\)/.test(head)) return "script-error";
  if (tool === "bash" && CHECK_RUNNERS.test(head)) return "check-failed";
  if (tool === "bash" && /Command exited with code \d+/.test(tail)) return "exit-nonzero-other";
  return "unknown";
}
