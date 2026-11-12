import { expect, test } from "bun:test";
import { createReadCache, MAX_LOG, stubText, type StatFn } from "./cache.ts";

const BODY = "x".repeat(500);
function setup() {
  const files = new Map<string, { mtimeMs: number; size: number }>();
  const stat: StatFn = (p) => files.get(p);
  files.set("/w/a.ts", { mtimeMs: 1, size: 500 });
  const cache = createReadCache({ cwd: () => "/w", stat });
  let n = 0;
  const read = (input: Record<string, unknown>, text = BODY, content?: any[]) => {
    const id = `c${n++}`;
    cache.onToolCall({ toolName: "read", toolCallId: id, input });
    return cache.onToolResult({
      toolName: "read",
      toolCallId: id,
      input,
      content: content ?? [{ type: "text", text }],
    });
  };
  return { files, cache, read };
}

test("repeat read of unchanged file gets stub naming earlier turn", () => {
  const { cache, read } = setup();
  cache.onTurnStart();
  expect(read({ path: "a.ts" })).toBeUndefined();
  cache.onTurnStart();
  expect(read({ path: "a.ts" })?.content).toEqual([{ type: "text", text: stubText(1) }]);
  expect(cache.stats().count).toBe(1);
});

test("relative, @-prefixed and absolute paths share one key", () => {
  const { read } = setup();
  read({ path: "a.ts" });
  expect(read({ path: "@a.ts" })).toBeDefined();
  expect(read({ path: "/w/a.ts" })).toBeDefined();
});

test("different offset or limit is a different slice", () => {
  const { read } = setup();
  read({ path: "a.ts", offset: 1, limit: 10 });
  expect(read({ path: "a.ts", offset: 11, limit: 10 })).toBeUndefined();
  expect(read({ path: "a.ts", offset: 1, limit: 20 })).toBeUndefined();
  expect(read({ path: "a.ts", offset: 1, limit: 10 })).toBeDefined();
});

test("changed mtime (bash write) gives fresh content", () => {
  const { files, read } = setup();
  read({ path: "a.ts" });
  files.set("/w/a.ts", { mtimeMs: 2, size: 500 });
  expect(read({ path: "a.ts" })).toBeUndefined();
  expect(read({ path: "a.ts" })).toBeDefined(); // new stat now cached
});

test("changed size gives fresh content", () => {
  const { files, read } = setup();
  read({ path: "a.ts" });
  files.set("/w/a.ts", { mtimeMs: 1, size: 501 });
  expect(read({ path: "a.ts" })).toBeUndefined();
});

test("agent edit or write drops the entry even if stat is unchanged", () => {
  for (const tool of ["edit", "write"]) {
    const { cache, read } = setup();
    read({ path: "a.ts" });
    cache.onToolCall({ toolName: tool, toolCallId: "e", input: { path: "a.ts" } });
    expect(read({ path: "a.ts" })).toBeUndefined();
  }
});

test("edit of one file keeps other files cached", () => {
  const { files, cache, read } = setup();
  files.set("/w/b.ts", { mtimeMs: 1, size: 500 });
  read({ path: "b.ts" });
  cache.onToolCall({ toolName: "edit", toolCallId: "e", input: { path: "a.ts" } });
  expect(read({ path: "b.ts" })).toBeDefined();
});

test("reset (compaction) forces full content", () => {
  const { cache, read } = setup();
  read({ path: "a.ts" });
  cache.reset();
  expect(read({ path: "a.ts" })).toBeUndefined();
});

test("images are never stubbed, by extension or by content part", () => {
  const { files, read } = setup();
  files.set("/w/p.png", { mtimeMs: 1, size: 500 });
  files.set("/w/q.dat", { mtimeMs: 1, size: 500 });
  const img = [
    { type: "text", text: BODY },
    { type: "image", data: "AA" },
  ];
  read({ path: "p.png" });
  expect(read({ path: "p.png" })).toBeUndefined();
  read({ path: "q.dat" }, BODY, img);
  expect(read({ path: "q.dat" }, BODY, img)).toBeUndefined();
});

test("error results are not cached and not stubbed", () => {
  const { cache } = setup();
  const input = { path: "a.ts" };
  for (let i = 0; i < 2; i++) {
    cache.onToolCall({ toolName: "read", toolCallId: `x${i}`, input });
    expect(
      cache.onToolResult({
        toolName: "read",
        toolCallId: `x${i}`,
        input,
        content: [{ type: "text", text: BODY }],
        isError: true,
      }),
    ).toBeUndefined();
  }
  expect(cache.stats().entries).toBe(0);
});

test("result not larger than the stub is left alone", () => {
  const { read } = setup();
  read({ path: "a.ts" }, "tiny");
  expect(read({ path: "a.ts" }, "tiny")).toBeUndefined();
});

test("missing file is left alone", () => {
  const { read } = setup();
  expect(read({ path: "gone.ts" })).toBeUndefined();
  expect(read({ path: "gone.ts" })).toBeUndefined();
});

test("a write between the stat and a later read of old stat does not match", () => {
  // stat is taken before the read runs: file changed during the read means next read differs
  const { files, cache } = setup();
  const input = { path: "a.ts" };
  cache.onToolCall({ toolName: "read", toolCallId: "r1", input });
  files.set("/w/a.ts", { mtimeMs: 9, size: 500 }); // written while read ran
  cache.onToolResult({
    toolName: "read",
    toolCallId: "r1",
    input,
    content: [{ type: "text", text: BODY }],
  });
  cache.onToolCall({ toolName: "read", toolCallId: "r2", input });
  expect(
    cache.onToolResult({
      toolName: "read",
      toolCallId: "r2",
      input,
      content: [{ type: "text", text: BODY }],
    }),
  ).toBeUndefined();
});

test("substitution log is bounded and counts bytes", () => {
  const { files, cache, read } = setup();
  for (let i = 0; i < MAX_LOG + 20; i++) {
    files.set(`/w/f${i}.ts`, { mtimeMs: 1, size: 500 });
    read({ path: `f${i}.ts` });
    read({ path: `f${i}.ts` });
  }
  const s = cache.stats();
  expect(s.count).toBe(MAX_LOG + 20);
  expect(s.recent.length).toBe(MAX_LOG);
  expect(s.totalSaved).toBe((MAX_LOG + 20) * (500 - stubText(0).length));
  expect(cache.formatStats(true)).toContain("substitutions: 70");
});
