import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandFamily, createGuard, NEVER_CAP, sha1 } from "./index.ts";
import { parseMode } from "./log.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guard-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const big = Array.from({ length: 200 }, (_, i) => `line ${i} secret-output`).join("\n");
const mk = (mode: "shadow" | "live", extra = {}) =>
  createGuard({
    mode,
    capBytes: 500,
    logPath: join(dir, "logs", "g.jsonl"),
    spillDir: join(dir, "spill"),
    ...extra,
  });
const result = (command: string, text: string, id = "c1") => ({
  toolName: "bash",
  toolCallId: id,
  input: { command },
  content: [{ type: "text", text }],
});
const logged = () =>
  readFileSync(join(dir, "logs", "g.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("parseMode defaults to shadow", () => {
  expect(parseMode(undefined)).toBe("shadow");
  expect(parseMode("garbage")).toBe("shadow");
  expect(parseMode("live")).toBe("live");
  expect(parseMode("off")).toBe("off");
  expect(NEVER_CAP).toEqual([]);
  expect(commandFamily("git diff --stat HEAD")).toBe("git diff");
});

test("commandFamily skips cd and env prefixes and logs no extra words", () => {
  expect(commandFamily("cd ~/.pi && bun test foo")).toBe("bun test");
  expect(commandFamily("cd /a/b; git status -s")).toBe("git status");
  expect(commandFamily('cd "/a b" && cd c && FOO=1 BAR="x y" pnpm lint --fix')).toBe("pnpm lint");
  expect(commandFamily("FOO=1 rg -n x")).toBe("rg -n");
  expect(commandFamily("ls -la | grep secret")).toBe("ls -la");
  expect(commandFamily("git diff && cat /secret/path")).toBe("git diff");
  expect(commandFamily("  ls")).toBe("ls");
});

test("shadow mode keeps content and logs without command or output text", () => {
  const g = mk("shadow");
  g.start();
  const out = g.onToolResult(result("git diff --token=SECRET HEAD", big));
  expect(out).toBeUndefined();
  const [rec] = logged();
  expect(rec.rule).toBe("cap");
  expect(rec.family).toBe("git diff");
  expect(rec.cmdSha1).toBe(sha1("git diff --token=SECRET HEAD"));
  expect(rec.bytes).toBe(Buffer.byteLength(big));
  expect(rec.removed).toBeGreaterThan(0);
  expect(rec.session).toMatch(/^[0-9a-f]{12}$/);
  const raw = readFileSync(join(dir, "logs", "g.jsonl"), "utf8");
  expect(raw).not.toContain("SECRET");
  expect(raw).not.toContain("secret-output");
  expect(existsSync(join(dir, "spill"))).toBe(false);
});

test("small results and other tools are ignored", () => {
  const g = mk("shadow");
  g.start();
  expect(g.onToolResult(result("ls", "ok"))).toBeUndefined();
  expect(g.onToolResult({ ...result("x", big), toolName: "read" })).toBeUndefined();
  expect(existsSync(join(dir, "logs"))).toBe(false);
});

test("live mode truncates, keeps images and writes a 0600 spill file", () => {
  const g = mk("live");
  g.start();
  const img = { type: "image", data: "AAAA", mimeType: "image/png" };
  const out = g.onToolResult({
    ...result("rg -n foo", big, "call/1"),
    content: [{ type: "text", text: big }, img],
  })!;
  expect(out.content[1]).toEqual(img);
  const text = out.content[0]!.text!;
  expect(Buffer.byteLength(text)).toBeLessThan(700);
  const file = /full output: (\S+)\]/.exec(text)![1]!;
  expect(file.startsWith(join(dir, "spill"))).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(big);
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test("refetch: same command hash is logged, other commands are not", () => {
  const g = mk("shadow");
  g.start();
  g.onToolResult(result("rg -n foo", big));
  g.onToolCall({ toolName: "bash", toolCallId: "c2", input: { command: "ls" } });
  expect(logged().length).toBe(1);
  g.onToolCall({ toolName: "bash", toolCallId: "c3", input: { command: "rg -n foo" } });
  const recs = logged();
  expect(recs.length).toBe(2);
  expect(recs[1]).toMatchObject({ rule: "refetch", family: "rg -n", cmdSha1: sha1("rg -n foo") });
});

test("refetch: read or bash of a spill path is logged against the original command", () => {
  const g = mk("live");
  g.start();
  const out = g.onToolResult(result("git diff", big))!;
  const file = /full output: (\S+)\]/.exec(out.content[0]!.text!)![1]!;
  g.onToolCall({ toolName: "read", toolCallId: "r1", input: { path: file } });
  g.onToolCall({ toolName: "bash", toolCallId: "r2", input: { command: `tail -n 5 ${file}` } });
  g.onToolCall({ toolName: "read", toolCallId: "r3", input: { path: "/etc/hosts" } });
  const recs = logged().filter((r) => r.rule === "refetch");
  expect(recs.length).toBe(2);
  expect(recs[0]).toMatchObject({ family: "git diff", cmdSha1: sha1("git diff") });
});

test("fails open when the log directory is not writable", () => {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  const g = mk("shadow", { logPath: join(blocker, "sub", "g.jsonl") });
  g.start();
  expect(() => g.onToolResult(result("git diff", big))).not.toThrow();
  expect(g.onToolResult(result("git diff", big))).toBeUndefined();
  expect(() =>
    g.onToolCall({ toolName: "bash", toolCallId: "x", input: { command: "git diff" } }),
  ).not.toThrow();
});

test("live mode fails open when the spill file cannot be written", () => {
  const blocker = join(dir, "blocker");
  writeFileSync(blocker, "x");
  const g = mk("live", { spillDir: join(blocker, "spill") });
  g.start();
  expect(g.onToolResult(result("git diff", big))).toBeUndefined();
});

test("live session start deletes spill files older than 7 days only", () => {
  const g = mk("live");
  g.start();
  g.onToolResult(result("git diff", big));
  const spill = join(dir, "spill");
  const old = join(spill, "old.txt");
  writeFileSync(old, "x");
  const t = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  utimesSync(old, t, t);
  g.start();
  const left = readdirSync(spill);
  expect(left).not.toContain("old.txt");
  expect(left.length).toBe(1);
});
