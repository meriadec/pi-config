import { expect, test } from "bun:test";
import { createHooks } from "./index.ts";
import type { Rec } from "./rules.ts";

const T = "mcp__t3-code__";
const SECRET = "SECRET-TASK-TEXT-do-not-log";
const del = (id: string, input: Record<string, unknown> = {}) => ({
  toolName: `${T}delegate_task`,
  toolCallId: id,
  input: { task: SECRET + (input["n"] ?? ""), role: "implementation", ...input },
});
const ok = (id: string, n: string) => ({
  toolName: `${T}delegate_task`,
  toolCallId: id,
  isError: false,
  content: [
    {
      type: "text",
      text: JSON.stringify({ taskId: `task-${n}`, childThreadId: `thr-${n}`, status: "running" }),
    },
  ],
});
const fail = (id: string) => ({
  toolName: `${T}delegate_task`,
  toolCallId: id,
  isError: true,
  content: [{ type: "text", text: "fetch failed" }],
});

function setup(mode: "shadow" | "live", max = 6) {
  const logs: Rec[] = [];
  const messages: { customType: string; content: string }[] = [];
  const hooks = createHooks({
    mode,
    max,
    log: (r) => logs.push(r),
    sendMessage: (m) => messages.push(m),
  });
  return { hooks, logs, messages };
}
const wouldBlock = (logs: Rec[], rule: string) =>
  logs.filter((l) => l["event"] === "would_block" && l["rule"] === rule).length;

test("child cap: shadow logs would_block and lets the call run", () => {
  const { hooks, logs } = setup("shadow", 2);
  for (let i = 0; i < 3; i++)
    expect(hooks.onToolCall(del(`c${i}`, { n: String(i) }))).toBeUndefined();
  expect(wouldBlock(logs, "child-cap")).toBe(1);
});

test("child cap: live blocks the call past the cap and names PI_DELEGATION_MAX", () => {
  const { hooks, logs } = setup("live", 2);
  expect(hooks.onToolCall(del("c0", { n: "0" }))).toBeUndefined();
  expect(hooks.onToolCall(del("c1", { n: "1" }))).toBeUndefined();
  const r = hooks.onToolCall(del("c2", { n: "2" }));
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain("PI_DELEGATION_MAX");
  expect(logs.filter((l) => l["event"] === "block").length).toBe(1);
});

test("child cap counts each thread of create_threads", () => {
  const { hooks } = setup("live", 3);
  const r = hooks.onToolCall({
    toolName: `${T}create_threads`,
    toolCallId: "m",
    input: { threads: [{ message: "a" }, { message: "b" }, { message: "c" }, { message: "d" }] },
  });
  expect(r?.block).toBe(true);
  const { hooks: h2, logs } = setup("shadow", 9);
  h2.onToolCall({
    toolName: `${T}create_threads`,
    toolCallId: "m",
    input: { threads: [{ message: "a" }, { message: "b" }] },
  });
  expect(logs.filter((l) => l["event"] === "call").length).toBe(2);
});

test("duplicate after fetch failed: live blocks, hint gives clientRequestId; with id it passes", () => {
  const { hooks } = setup("live");
  hooks.onToolCall(del("a"));
  hooks.onToolResult(fail("a"));
  const r = hooks.onToolCall(del("b"));
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain('"clientRequestId"');
  expect(hooks.onToolCall(del("c", { clientRequestId: "r1" }))).toBeUndefined();
});

test("duplicate after fetch failed: shadow only logs", () => {
  const { hooks, logs } = setup("shadow");
  hooks.onToolCall(del("a"));
  hooks.onToolResult(fail("a"));
  expect(hooks.onToolCall(del("b"))).toBeUndefined();
  expect(wouldBlock(logs, "duplicate")).toBe(1);
});

test("duplicate: same task, no clientRequestId, earlier call without result", () => {
  const { hooks } = setup("live");
  hooks.onToolCall(del("a"));
  expect(hooks.onToolCall(del("b"))?.block).toBe(true);
  // an earlier call WITH a result and OK is not a duplicate by this rule
  const { hooks: h2 } = setup("live");
  h2.onToolCall(del("a"));
  h2.onToolResult(ok("a", "1"));
  expect(h2.onToolCall(del("b"))).toBeUndefined();
});

test("different task text after a failure is not a duplicate", () => {
  const { hooks } = setup("live");
  hooks.onToolCall(del("a", { n: "1" }));
  hooks.onToolResult(fail("a"));
  expect(hooks.onToolCall(del("b", { n: "2" }))).toBeUndefined();
});

test("log never holds task text; keeps length, sha1, hashed ids", () => {
  const { hooks, logs } = setup("shadow");
  hooks.onToolCall(del("a", { target: { model: "gpt-x" }, mode: "async" }));
  hooks.onToolResult(ok("a", "1"));
  hooks.onToolCall({ toolName: `${T}task_status`, toolCallId: "s", input: { taskId: "task-1" } });
  const dump = JSON.stringify(logs);
  expect(dump).not.toContain(SECRET);
  expect(dump).not.toContain("task-1");
  expect(dump).not.toContain("thr-1");
  const call = logs.find((l) => l["event"] === "call")!;
  expect(call["taskLen"]).toBe(Buffer.byteLength(SECRET));
  expect(call["model"]).toBe("gpt-x");
  expect(call["hasClientRequestId"]).toBe(false);
  const res = logs.find((l) => l["event"] === "result")!;
  expect(res["ok"]).toBe(true);
  expect(res["status"]).toBe("running");
  expect(res["taskIdHash"]).toHaveLength(40);
  const fu = logs.find((l) => l["event"] === "followup")!;
  expect(fu["linkedCall"]).toBe("a");
});

test("result log classifies fetch failed and other errors", () => {
  const { hooks, logs } = setup("shadow");
  hooks.onToolCall(del("a", { n: "1" }));
  hooks.onToolResult(fail("a"));
  hooks.onToolCall(del("b", { n: "2" }));
  hooks.onToolResult({ ...fail("b"), content: [{ type: "text", text: "boom" }] });
  const classes = logs.filter((l) => l["event"] === "result").map((l) => l["errorClass"]);
  expect(classes).toEqual(["fetch-failed", "other"]);
});

test("unchecked async children are logged once per distinct set and never messaged", () => {
  const { hooks, messages, logs } = setup("live");
  const unchecked = () => logs.filter((r) => r["event"] === "unchecked-async");
  hooks.onToolCall(del("a", { n: "1" }));
  hooks.onToolResult(ok("a", "1"));
  hooks.onAgentEnd();
  hooks.onAgentEnd();
  expect(unchecked().length).toBe(1);
  expect(unchecked()[0]!["orphans"]).toBe(1);
  hooks.onToolCall(del("b", { n: "2" }));
  hooks.onToolResult(ok("b", "2"));
  hooks.onAgentEnd();
  expect(unchecked().length).toBe(2);
  expect(messages.length).toBe(0);
});

test("wait-mode children are not logged as unchecked", () => {
  const live = setup("live");
  live.hooks.onToolCall(del("a", { mode: "wait" }));
  live.hooks.onToolResult(ok("a", "1"));
  live.hooks.onAgentEnd();
  expect(live.logs.filter((r) => r["event"] === "unchecked-async").length).toBe(0);
  expect(live.messages.length).toBe(0);
});

test("a thread read of the child thread also counts as a check", () => {
  const { hooks, messages } = setup("live");
  hooks.onToolCall(del("a"));
  hooks.onToolResult(ok("a", "1"));
  hooks.onToolCall({
    toolName: `${T}t3_thread_read`,
    toolCallId: "r",
    input: { threadId: "thr-1" },
  });
  hooks.onAgentEnd();
  expect(messages.length).toBe(0);
});

test("off mode logs and blocks nothing", () => {
  const logs: Rec[] = [];
  const hooks = createHooks({ mode: "off", max: 0, log: (r) => logs.push(r) });
  expect(hooks.onToolCall(del("a"))).toBeUndefined();
  hooks.onToolResult(ok("a", "1"));
  expect(logs).toEqual([]);
});

test("fail open: garbage events and a throwing logger never block or throw", () => {
  const { hooks } = setup("live");
  expect(hooks.onToolCall(null as never)).toBeUndefined();
  expect(hooks.onToolResult(null as never)).toBeUndefined();
  const bad = createHooks({
    mode: "live",
    max: 0, // the cap would block
    log: () => {
      throw new Error("disk full");
    },
  });
  expect(bad.onToolCall(del("a"))).toBeUndefined();
  expect(() => bad.onAgentEnd()).not.toThrow();
  expect(
    hooks.onToolCall({ toolName: `${T}delegate_task`, toolCallId: "z", input: 5 }),
  ).toBeUndefined();
});
