import { expect, test } from "bun:test";
import { classifyFailure } from "./classify.ts";

const cases: [string, string, string, string][] = [
  ["hashline anchor", "edit", "[E_BAD_REF] Invalid line reference", "edit-bad-anchor"],
  ["schema", "edit", 'Validation failed for tool "edit":', "edit-schema-invalid"],
  ["multi match", "edit", "[E_MULTI_MATCH] replace_text found multiple", "edit-multi-match"],
  ["missing file on read", "read", "File not found: /tmp/a.png", "path-not-found"],
  [
    "codemode sandbox",
    "codemode",
    "ReferenceError: setTimeout is not defined",
    "sandbox-capability",
  ],
  ["t3 task", "mcp__t3-code__task_status", '{"code":"task_not_found"}', "t3-task-not-found"],
  [
    "lint run",
    "bash",
    "$ biome check --error-on-warnings\nerror\n\nCommand exited with code 1",
    "check-failed",
  ],
  ["bash tool timeout", "bash", "Command timed out after 20 seconds", "timeout"],
  [
    "browser wait gave up",
    "bash",
    "\u2713 Done\n\u2717 Wait timed out after 25000ms\n\nCommand exited with code 1",
    "browser-wait-timeout",
  ],
  [
    "word timeout in a test log",
    "bash",
    "FAIL timeout waiting for input\n\nCommand exited with code 1",
    "exit-nonzero-other",
  ],
  ["plain exit", "bash", "boom\n\nCommand exited with code 2", "exit-nonzero-other"],
  ["grep no match", "bash", "(no output)  Command exited with code 1", "empty-result-exit1"],
  [
    "grep no match in raw JSON",
    "bash",
    String.raw`[{"text":"(no output)\n\nCommand exited with code 1"}]`,
    "empty-result-exit1",
  ],
  ["duplicate old text", "edit", "Found 2 occurrences of edits[1] in a.ts", "edit-multi-match"],
  ["old text missing", "edit", "Could not find edits[5] in a.md.", "edit-no-match"],
  ["empty append", "edit", "[E_BAD_OP] Append with empty lines", "edit-bad-op"],
  ["read directory", "read", "EISDIR: illegal operation on a directory, read", "read-misuse"],
  [
    "shell quoting",
    "bash",
    "/bin/bash: -c: line 1: unexpected EOF while looking for matching",
    "shell-syntax",
  ],
  ["python crash", "bash", "Traceback (most recent call last):\n  File x", "script-error"],
  ["sigterm", "bash", "(no output)  Command exited with code 143", "killed-sigterm"],
  ["abort", "bash", "x\n\nCommand aborted", "aborted"],
  [
    "5xx",
    "mcp__enterprise_remote__list_workspaces",
    "Revault request failed (503)",
    "network-or-5xx",
  ],
  ["unknown", "bash", "hello", "unknown"],
];

for (const [name, tool, text, expected] of cases) {
  test(`classifies ${name}`, () => {
    expect(classifyFailure(tool, text)).toBe(expected as ReturnType<typeof classifyFailure>);
  });
}

test("a test-runner header does not hide a missing file", () => {
  expect(classifyFailure("bash", "$ bun test\nENOENT: no such file")).toBe("path-not-found");
});
