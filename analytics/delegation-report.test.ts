import { expect, test } from "bun:test";
import { callsFromSession, liveSummary, summarizeCalls } from "./delegation-report.ts";
import { sha1 } from "../agent/extensions/delegation-guard/rules.ts";

const T = "mcp__t3-code__";
const line = (message: object) => JSON.stringify({ type: "message", message });
const call = (id: string, name: string, args: object) =>
  line({ role: "assistant", content: [{ type: "toolCall", id, name: T + name, arguments: args }] });
const res = (id: string, text: string, isError = false) =>
  line({ role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError });
const okText = (n: string) =>
  JSON.stringify({ taskId: `t${n}`, childThreadId: `h${n}`, status: "running" });

const session = [
  call("1", "delegate_task", { task: "A", role: "review", target: { model: "m1" } }),
  res("1", okText("1")),
  call("2", "delegate_task", { task: "B", mode: "wait", role: "implementation" }),
  res("2", okText("2")),
  call("3", "delegate_task", { task: "C" }),
  res("3", "fetch failed", true),
  call("4", "delegate_task", { task: "C" }),
  res("4", okText("4")),
  call("5", "delegate_task", { task: "D" }),
  res("5", okText("5")),
  call("6", "task_status", { taskId: "t5" }),
  call("7", "t3_thread_read", { threadId: "h4" }),
].join("\n");

test("history: counts, error classes, orphans, retry duplicates, peak", () => {
  const s = summarizeCalls(callsFromSession("s1", session));
  expect(s.calls).toBe(5);
  expect(s.perModel).toEqual({ m1: 1, "(default)": 4 });
  expect(s.perRole["review"]).toBe(1);
  expect(s.perMode).toEqual({ async: 4, wait: 1 });
  expect(s.errors).toBe(1);
  expect(s.errorClasses).toEqual({ "fetch-failed": 1 });
  expect(s.errorRate).toBeCloseTo(0.2);
  expect(s.orphans).toBe(1); // only call 1: call 2 waits, 4 read by thread, 5 has task_status
  expect(s.retryDuplicates).toBe(1);
  expect(s.peakChildren).toBe(5);
});

test("history: a status call for another session does not clear an orphan; sessions are separate", () => {
  const a = callsFromSession(
    "a",
    [call("1", "delegate_task", { task: "A" }), res("1", okText("1"))].join("\n"),
  );
  const b = callsFromSession("b", [call("9", "task_status", { taskId: "t1" })].join("\n"));
  const s = summarizeCalls([...a, ...b]);
  expect(s.orphans).toBe(1);
  expect(s.sessions).toBe(1);
});

test("live: same counts plus would_block per rule", () => {
  const r = (o: object) => JSON.stringify({ session: "x", ...o });
  const jsonl = [
    r({
      event: "call",
      callId: "a",
      tool: "delegate_task",
      mode: "async",
      model: "m",
      taskSha1: sha1("A"),
    }),
    r({ event: "result", callId: "a", ok: true }),
    r({ event: "call", callId: "b", tool: "delegate_task", mode: "async", taskSha1: sha1("B") }),
    r({ event: "result", callId: "b", ok: false, errorClass: "fetch-failed" }),
    r({ event: "call", callId: "c", tool: "delegate_task", mode: "async", taskSha1: sha1("B") }),
    r({ event: "would_block", callId: "c", rule: "duplicate" }),
    r({ event: "would_block", rule: "orphan-note" }),
    r({ event: "block", callId: "c", rule: "child-cap" }),
    "garbage",
  ].join("\n");
  const s = liveSummary(jsonl);
  expect(s.calls).toBe(3);
  expect(s.errors).toBe(1);
  expect(s.errorClasses).toEqual({ "fetch-failed": 1 });
  expect(s.orphans).toBe(1);
  expect(s.retryDuplicates).toBe(1);
  expect(s.wouldBlock).toEqual({ duplicate: 1, "orphan-note": 1 });
  expect(s.blocked).toEqual({ "child-cap": 1 });
  const followed = liveSummary(
    [
      r({ event: "call", callId: "a", tool: "delegate_task", mode: "async", taskSha1: "z" }),
      r({ event: "result", callId: "a", ok: true }),
      r({ event: "followup", linkedCall: "a" }),
    ].join("\n"),
  );
  expect(followed.orphans).toBe(0);
});
