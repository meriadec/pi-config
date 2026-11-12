import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuard } from "./index.ts";
import { ReadTracker } from "./reread.ts";

const base = { mtimeMs: 10, size: 5000, offset: undefined, limit: undefined };

test("tracker: identical re-read is unchanged and reports first turn and bytes", () => {
  const t = new ReadTracker();
  t.record("/a", { ...base, turn: 3, bytes: 4800 });
  expect(t.check("/a", base)).toEqual({ unchanged: true, firstTurn: 3, bytes: 4800 });
  expect(t.check("/b", base)).toBeUndefined();
});

test("tracker: changed mtime, size or slice is not unchanged", () => {
  const t = new ReadTracker();
  t.record("/a", { ...base, turn: 1, bytes: 4800 });
  expect(t.check("/a", { ...base, mtimeMs: 11 })).toBeUndefined();
  expect(t.check("/a", { ...base, size: 5001 })).toBeUndefined();
  expect(t.check("/a", { ...base, offset: 10 })).toBeUndefined();
  expect(t.check("/a", { ...base, limit: 10 })).toBeUndefined();
});

test("tracker: the same slice is matched, another slice stays separate", () => {
  const t = new ReadTracker();
  t.record("/a", { ...base, offset: 5, limit: 20, turn: 1, bytes: 2000 });
  expect(t.check("/a", { ...base, offset: 5, limit: 20 })).toBeDefined();
  expect(t.check("/a", base)).toBeUndefined();
});

test("tracker: reset (compaction) forgets all reads", () => {
  const t = new ReadTracker();
  t.record("/a", { ...base, turn: 1, bytes: 4800 });
  t.reset();
  expect(t.check("/a", base)).toBeUndefined();
});

// ---- guard integration ----
let dir: string;
let file: string;
const body = "x".repeat(3000);
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reread-"));
  file = join(dir, "AGENTS.md");
  writeFileSync(file, body);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (mode: "shadow" | "live") => {
  const g = createGuard({
    mode,
    logPath: join(dir, "logs", "g.jsonl"),
    spillDir: join(dir, "spill"),
  });
  g.start();
  return g;
};
const call = (input: Record<string, unknown>) => ({ toolName: "read", input });
const res = (input: Record<string, unknown>, text = body, isError = false) => ({
  toolName: "read",
  input,
  content: [{ type: "text", text }],
  isError,
});
const logged = () => {
  try {
    return readFileSync(join(dir, "logs", "g.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const rereads = () => logged().filter((r) => r.rule === "reread");

test("shadow: unchanged re-read is logged, the call is left alone", () => {
  const g = mk("shadow");
  g.onTurn();
  g.onReadResult(res({ path: file }), dir);
  g.onTurn();
  g.onTurn();
  expect(g.onReadCall(call({ path: file }), dir)).toBeUndefined();
  const [r] = rereads();
  expect(r).toMatchObject({ tool: "read", path_ext: "AGENTS.md", bytes: 3000, turnsSince: 2 });
});

test("relative path resolves against cwd", () => {
  const g = mk("shadow");
  g.onReadResult(res({ path: "AGENTS.md" }), dir);
  g.onReadCall(call({ path: "./AGENTS.md" }), dir);
  expect(rereads().length).toBe(1);
});

test("log has no full path; other files log only the extension", () => {
  const g = mk("shadow");
  const f = join(dir, "secret-name.ts");
  writeFileSync(f, body);
  g.onReadResult(res({ path: f }), dir);
  g.onReadCall(call({ path: f }), dir);
  const raw = readFileSync(join(dir, "logs", "g.jsonl"), "utf8");
  expect(rereads()[0].path_ext).toBe(".ts");
  expect(raw).not.toContain("secret-name");
  expect(raw).not.toContain(dir);
});

test("changed content (mtime or size) is not detected", () => {
  const g = mk("shadow");
  g.onReadResult(res({ path: file }), dir);
  const t = new Date(Date.now() + 5000);
  utimesSync(file, t, t);
  g.onReadCall(call({ path: file }), dir);
  expect(rereads().length).toBe(0);
  g.onReadResult(res({ path: file }), dir);
  writeFileSync(file, body + "y");
  utimesSync(file, t, t);
  g.onReadCall(call({ path: file }), dir);
  expect(rereads().length).toBe(0);
});

test("different slice is not detected", () => {
  const g = mk("shadow");
  g.onReadResult(res({ path: file }), dir);
  g.onReadCall(call({ path: file, offset: 2 }), dir);
  g.onReadCall(call({ path: file, limit: 2 }), dir);
  expect(rereads().length).toBe(0);
});

test("compaction and session start reset the tracker", () => {
  const g = mk("shadow");
  g.onReadResult(res({ path: file }), dir);
  g.onCompact();
  g.onReadCall(call({ path: file }), dir);
  expect(rereads().length).toBe(0);
  g.onReadResult(res({ path: file }), dir);
  g.start();
  g.onReadCall(call({ path: file }), dir);
  expect(rereads().length).toBe(0);
});

test("images and tiny files are skipped", () => {
  const g = mk("shadow");
  const img = join(dir, "a.PNG");
  writeFileSync(img, body);
  g.onReadResult(res({ path: img }), dir);
  g.onReadCall(call({ path: img }), dir);
  const tiny = join(dir, "tiny.md");
  writeFileSync(tiny, "x".repeat(1499));
  g.onReadResult(res({ path: tiny }, "x".repeat(1499)), dir);
  g.onReadCall(call({ path: tiny }), dir);
  expect(rereads().length).toBe(0);
  const edge = join(dir, "edge.md");
  writeFileSync(edge, "x".repeat(1500));
  g.onReadResult(res({ path: edge }, "x".repeat(1500)), dir);
  g.onReadCall(call({ path: edge }), dir);
  expect(rereads().length).toBe(1);
});

test("failed reads and image-only results are not recorded", () => {
  const g = mk("shadow");
  g.onReadResult(res({ path: file }, body, true), dir);
  g.onReadResult({ ...res({ path: file }), content: [{ type: "image" }] }, dir);
  g.onReadCall(call({ path: file }), dir);
  expect(rereads().length).toBe(0);
});

test("live: blocks once, then lets the insisting repeat through", () => {
  const g = mk("live");
  g.onTurn();
  g.onReadResult(res({ path: file }), dir);
  const first = g.onReadCall(call({ path: file }), dir);
  expect(first).toEqual({
    block: true,
    reason:
      "File unchanged since your read at turn 1 (3000 bytes). Use the earlier result, or read a different slice.",
  });
  expect(g.onReadCall(call({ path: file }), dir)).toBeUndefined();
  g.onReadResult(res({ path: file }), dir);
  // a later, new unchanged read is blocked again
  expect(g.onReadCall(call({ path: file }), dir)?.block).toBe(true);
});

test("fails open when stat throws (missing file)", () => {
  const g = mk("live");
  g.onReadResult(res({ path: file }), dir);
  rmSync(file);
  expect(g.onReadCall(call({ path: file }), dir)).toBeUndefined();
  expect(() => g.onReadResult(res({ path: join(dir, "none.md") }), dir)).not.toThrow();
  expect(g.onReadCall(call({}), dir)).toBeUndefined();
});
