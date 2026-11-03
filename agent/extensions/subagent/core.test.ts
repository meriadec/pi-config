import { describe, expect, test } from "bun:test";
import {
  aggregateUsage,
  applyEventLine,
  buildChildArgs,
  buildChildEnvironment,
  CHILD_ENV_FLAG,
  getDisplayItems,
  getResultOutput,
  isFailed,
  mapWithConcurrencyLimit,
  newChildResult,
  truncateOutput,
} from "./core.ts";

const assistantEnd = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content,
      model: "m1",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 1,
        cacheWrite: 2,
        totalTokens: 18,
        cost: { total: 0.5 },
      },
      ...extra,
    },
  });

describe("buildChildArgs", () => {
  test("fresh child is ephemeral and puts the prompt after --", () => {
    const args = buildChildArgs({
      prompt: "-rf @x",
      model: "p/m",
      thinking: "low",
      tools: ["read", "grep"],
    });
    expect(args).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--model",
      "p/m",
      "--thinking",
      "low",
      "--tools",
      "read,grep",
      "--",
      "-rf @x",
    ]);
  });

  test("fork child uses the parent session file and a private session dir", () => {
    const args = buildChildArgs({
      prompt: "go",
      forkSessionFile: "/s/a.jsonl",
      sessionDir: "/tmp/d",
    });
    expect(args).toContain("--fork");
    expect(args).not.toContain("--no-session");
    expect(args.slice(args.indexOf("--fork"), args.indexOf("--fork") + 4)).toEqual([
      "--fork",
      "/s/a.jsonl",
      "--session-dir",
      "/tmp/d",
    ]);
  });

  test("fork without session dir is rejected", () => {
    expect(() => buildChildArgs({ prompt: "go", forkSessionFile: "/s/a.jsonl" })).toThrow();
  });
});

describe("buildChildEnvironment", () => {
  test("sets the recursion guard and removes Topic identity", () => {
    const env = buildChildEnvironment({ PI_WORK_TOPIC_ID: "t", PI_WORK_SOCKET: "s", KEEP: "1" });
    expect(env[CHILD_ENV_FLAG]).toBe("1");
    expect(env["PI_WORK_TOPIC_ID"]).toBeUndefined();
    expect(env["PI_WORK_SOCKET"]).toBeUndefined();
    expect(env["KEEP"]).toBe("1");
  });
});

describe("applyEventLine", () => {
  test("ignores garbage, blank lines, and non-message events", () => {
    const r = newChildResult("a", "p");
    expect(applyEventLine(r, "")).toBe(false);
    expect(applyEventLine(r, "not json")).toBe(false);
    expect(applyEventLine(r, JSON.stringify({ type: "turn_start" }))).toBe(false);
    expect(
      applyEventLine(
        r,
        JSON.stringify({ type: "message_end", message: { role: "user", content: [] } }),
      ),
    ).toBe(false);
    expect(
      applyEventLine(
        r,
        JSON.stringify({ type: "message_end", message: { role: "system", content: "" } }),
      ),
    ).toBe(false);
    expect(r.messages).toHaveLength(0);
  });

  test("accumulates usage, model, and messages across turns", () => {
    const r = newChildResult("a", "p");
    expect(
      applyEventLine(
        r,
        assistantEnd([{ type: "toolCall", name: "read", arguments: { path: "x" } }]),
      ),
    ).toBe(true);
    applyEventLine(
      r,
      JSON.stringify({ type: "message_end", message: { role: "toolResult", content: [] } }),
    );
    applyEventLine(r, assistantEnd([{ type: "text", text: "done" }], { stopReason: "stop" }));
    expect(r.usage).toMatchObject({ input: 20, output: 10, cost: 1, turns: 2, contextTokens: 18 });
    expect(r.model).toBe("m1");
    expect(r.messages).toHaveLength(3);
    expect(getDisplayItems(r.messages)).toEqual([
      { type: "toolCall", name: "read", args: { path: "x" } },
      { type: "text", text: "done" },
    ]);
  });
});

describe("result helpers", () => {
  test("running child is not failed; error stop reason is", () => {
    const r = newChildResult("a", "p");
    expect(isFailed(r)).toBe(false);
    r.exitCode = 0;
    r.stopReason = "error";
    r.errorMessage = "boom";
    expect(isFailed(r)).toBe(true);
    expect(getResultOutput(r)).toBe("boom");
  });

  test("aggregateUsage sums children", () => {
    const a = newChildResult("a", "p");
    const b = newChildResult("b", "p");
    a.usage.cost = 1;
    b.usage.cost = 2;
    b.usage.turns = 3;
    expect(aggregateUsage([a, b])).toMatchObject({ cost: 3, turns: 3 });
  });

  test("truncateOutput cuts at a byte cap without splitting characters", () => {
    expect(truncateOutput("abc", 10)).toBe("abc");
    const out = truncateOutput("éééé", 5);
    expect(out.startsWith("éé")).toBe(true);
    expect(out).toContain("bytes omitted");
  });
});

describe("mapWithConcurrencyLimit", () => {
  test("keeps order and respects the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  test("empty input returns empty", async () => {
    expect(await mapWithConcurrencyLimit([], 3, async (x) => x)).toEqual([]);
  });
});
