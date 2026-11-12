import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuard } from "./index.ts";
import { isNoisyCommand, QUIET_EXCLUDE, quietSuccess } from "./quiet.ts";

const filler = (n: number, prefix = "progress") =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i} ${"x".repeat(30)}`);

test("QUIET_EXCLUDE starts empty", () => expect(QUIET_EXCLUDE).toEqual([]));

test("compound command rule", () => {
  expect(isNoisyCommand("cd x && pnpm lint")).toBe(true);
  expect(isNoisyCommand("pnpm lint | tee f")).toBe(true);
  expect(isNoisyCommand("pnpm lint && rm -rf y")).toBe(false);
  expect(isNoisyCommand("FOO=1 bun run build; echo done")).toBe(true);
  expect(isNoisyCommand("pnpm --filter web run gen")).toBe(true);
  expect(isNoisyCommand("git commit -m x")).toBe(true);
  expect(isNoisyCommand("ls -la")).toBe(false);
  expect(isNoisyCommand("echo hi")).toBe(false);
});

test("small output is untouched", () => {
  expect(quietSuccess("bun test", "ok\n".repeat(10))).toBeUndefined();
});

test("non-noisy command is untouched", () => {
  expect(quietSuccess("cat big.log", filler(300).join("\n"))).toBeUndefined();
});

test("ANSI CSI and OSC are stripped", () => {
  const lines = filler(300);
  lines[299] = "\x1b[31mred tail\x1b[0m \x1b]8;;http://x\x07link\x1b]8;;\x07";
  const r = quietSuccess("bun run build", lines.join("\n"))!;
  expect(r.text).toContain("red tail link");
  expect(r.text).not.toContain("\x1b");
});

test("warning line is kept with exactly one context line, in order, no duplicates", () => {
  const lines = filler(300);
  lines[100] = "context-before";
  lines[101] = "\x1b[33mWARNING: something odd\x1b[0m";
  const r = quietSuccess("pnpm lint", lines.join("\n"))!;
  const out = r.text.split("\n");
  expect(out[0]).toBe(`[quiet: kept ${out.length - 1} of 300 lines; command exited 0]`);
  const i = out.indexOf("context-before");
  expect(out[i + 1]).toBe("WARNING: something odd");
  expect(out).not.toContain(lines[99]);
  expect(out).not.toContain(lines[102]);
  expect(new Set(out).size).toBe(out.length);
  expect(out.slice(-15)).toEqual(lines.slice(-15));
  expect(r.removedBytes).toBeGreaterThan(5000);
});

test("bun test run with the word 'fail' keeps that line", () => {
  const lines = filler(300, "(pass) suite");
  lines[50] = "(pass) handles a fail-over case";
  lines[51] = "this word: failed appears";
  const r = quietSuccess("bun test", lines.join("\n"))!;
  expect(r.text).toContain("this word: failed appears");
  expect(r.text).not.toContain("(pass) suite 10 ");
});

test("at most 40 signal lines are kept", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `error number ${i} ${"y".repeat(20)}`);
  const r = quietSuccess("bun test", lines.join("\n"))!;
  // marker + <=40 signal lines + 15 tail lines
  expect(r.text.split("\n").length).toBeLessThanOrEqual(1 + 40 + 15);
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quiet-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (mode: "shadow" | "live", capBytes = 1_000_000) =>
  createGuard({
    mode,
    capBytes,
    logPath: join(dir, "g.jsonl"),
    spillDir: join(dir, "spill"),
  });
const noisy = filler(300);
noisy[10] = "SECRET-OUTPUT warning here";
const ev = (isError: boolean | undefined, text = noisy.join("\n"), command = "bun test") => ({
  toolName: "bash",
  toolCallId: "c1",
  input: { command },
  content: [
    { type: "text", text },
    { type: "image", data: "AAA" },
  ],
  isError,
});
const logged = () =>
  readFileSync(join(dir, "g.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("failing result is untouched in both modes", () => {
  for (const mode of ["shadow", "live"] as const) {
    const g = mk(mode);
    g.start();
    expect(g.onToolResult(ev(true))).toBeUndefined();
    expect(g.onToolResult(ev(undefined))).toBeUndefined();
    expect(
      g.onToolResult(ev(false, `${noisy.join("\n")}\n\nCommand exited with code 1`)),
    ).toBeUndefined();
  }
  expect(() => readFileSync(join(dir, "g.jsonl"), "utf8")).toThrow();
});

test("shadow leaves content unchanged but logs without text", () => {
  const g = mk("shadow");
  g.start();
  expect(g.onToolResult(ev(false))).toBeUndefined();
  const [rec] = logged();
  expect(rec.rule).toBe("quiet");
  expect(rec.family).toBe("bun test");
  expect(rec.cmdSha1).toMatch(/^[0-9a-f]{40}$/);
  expect(rec.removed).toBeGreaterThan(5000);
  expect(JSON.stringify(rec)).not.toContain("SECRET-OUTPUT");
});

test("live shortens the text, keeps image parts and logs", () => {
  const g = mk("live");
  g.start();
  const out = g.onToolResult(ev(false))!;
  expect(out.content[0]!.text).toStartWith("[quiet: kept");
  expect(out.content[0]!.text).toContain("SECRET-OUTPUT warning here");
  expect(out.content[1]).toEqual({ type: "image", data: "AAA" });
  expect(logged().map((r) => r.rule)).toEqual(["quiet"]);
});

test("quiet runs before cap: cap sees the shortened text", () => {
  // Original is ~10 KB; quiet text is ~1.5 KB. Cap at 5 KB must NOT fire.
  const g = mk("live", 5_000);
  g.start();
  const out = g.onToolResult(ev(false))!;
  expect(out.content[0]!.text).toStartWith("[quiet: kept");
  expect(logged().map((r) => r.rule)).toEqual(["quiet"]);
  // Cap at 500 bytes fires on the shortened text, after quiet.
  const g2 = mk("live", 500);
  g2.start();
  const out2 = g2.onToolResult(ev(false))!;
  expect(logged().map((r) => r.rule)).toEqual(["quiet", "quiet", "cap"]);
  expect(logged()[2].bytes).toBeLessThan(3_000);
  expect(out2.content[0]!.text).not.toBe(noisy.join("\n"));
});
