import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessions } from "./db.ts";
import { collect, renderReport, type PeriodStats } from "./report.ts";

const line = (o: unknown) => JSON.stringify(o);
const assistant = (ts: string, name: string, args: unknown) =>
  line({
    type: "message",
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "toolCall", name, arguments: args }] },
  });
const result = (ts: string, tool: string, text: string, isError: boolean) =>
  line({
    type: "message",
    timestamp: ts,
    message: { role: "toolResult", toolName: tool, isError, content: [{ type: "text", text }] },
  });

test("collect counts only the window: errors, classes, polling and wait_for", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rep-"));
  await mkdir(join(dir, "p"));
  await writeFile(
    join(dir, "p", "s.jsonl"),
    [
      assistant("2026-01-10T10:00:00Z", "bash", {
        command: "while true; do gh pr view 1; sleep 30; done",
      }),
      assistant("2026-01-10T10:01:00Z", "wait_for", { event: "pr.review" }),
      result("2026-01-10T10:02:00Z", "read", "File not found: /x", true),
      result("2026-01-10T10:03:00Z", "bash", "ok", false),
      assistant("2025-12-01T10:00:00Z", "bash", { command: "sleep 600" }),
      result("2025-12-01T10:01:00Z", "read", "File not found: /old", true),
    ].join("\n"),
  );
  const db = await openSessions(join(dir, "*/*.jsonl"));
  const s = await collect(db, new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
  expect(s.errors).toBe(1);
  expect(s.errorsByClass).toEqual({ "path-not-found": 1 });
  expect(s.toolingErrors).toBe(1);
  expect(s.pollingCalls).toBe(1);
  expect(s.waitForCalls).toBe(1);
  expect(s.toolCalls).toBe(2);
});

test("renderReport shows the change against the previous period", () => {
  const base: PeriodStats = {
    sessions: 10,
    toolCalls: 1000,
    errors: 50,
    toolingErrors: 10,
    errorsByClass: { "check-failed": 30 },
    bigResults: 20,
    resultMb: 100,
    pollingCalls: 10,
    waitForCalls: 0,
  };
  const out = renderReport({ ...base, pollingCalls: 5, waitForCalls: 4 }, base, 7, "2026-01-31");
  expect(out).toContain("| Hand-made polling commands | 5 | 10 | -50% |");
  expect(out).toContain("| wait_for calls | 4 | 0 | new |");
  expect(out).toContain("- check-failed: 30 (before: 30)");
});
