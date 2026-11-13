import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  describeLeftovers,
  findTagged,
  hasTag,
  parsePs,
  pickByMatch,
  SESSION_TAG_ENV,
  type TaggedProcess,
} from "./procscan.ts";

test("hasTag matches the exact session id only", () => {
  expect(hasTag(`A=1\0${SESSION_TAG_ENV}=abc\0B=2`, "abc")).toBe(true);
  expect(hasTag(`${SESSION_TAG_ENV}=abcd`, "abc")).toBe(false);
});

test("parsePs reads pid, parent, age and command", () => {
  expect(parsePs("  12  1  345 node server.js --port 3000\n")).toEqual([
    { pid: 12, ppid: 1, ageSeconds: 345, command: "node server.js --port 3000" },
  ]);
});

test("findTagged finds a real tagged process and ignores an untagged one", async () => {
  const tagged = spawn("sleep", ["30"], {
    env: { ...process.env, [SESSION_TAG_ENV]: "t-sess" },
    stdio: "ignore",
  });
  const other = spawn("sleep", ["31"], {
    env: { ...process.env, [SESSION_TAG_ENV]: "other" },
    stdio: "ignore",
  });
  try {
    const pids = (await findTagged("t-sess", 0)).map((p) => p.pid);
    expect(pids).toContain(tagged.pid as number);
    expect(pids).not.toContain(other.pid as number);
  } finally {
    tagged.kill();
    other.kill();
  }
});

test("describeLeftovers is empty when nothing runs", () => {
  expect(describeLeftovers([])).toBe("");
  expect(describeLeftovers([{ pid: 1, ppid: 0, ageSeconds: 600, command: "pnpm dev" }])).toContain(
    "pid 1, up 10 min: pnpm dev",
  );
});

const proc = (pid: number, ppid: number, command: string): TaggedProcess => ({
  pid,
  ppid,
  ageSeconds: 100,
  command,
});

test("pickByMatch returns the one match and ignores a shell that only wraps it", () => {
  const procs = [proc(10, 1, "bash -c pnpm dev --port 3000"), proc(11, 10, "pnpm dev --port 3000")];
  expect(pickByMatch(procs, "pnpm dev")).toMatchObject({ ok: true, process: { pid: 11 } });
});

test("pickByMatch fails with at most 5 candidates when many match", () => {
  const procs = Array.from({ length: 8 }, (_, i) => proc(100 + i, 1, `node vite-${i}`));
  const res = pickByMatch(procs, "vite");
  expect(res.ok).toBe(false);
  if (res.ok) return;
  expect(res.candidates).toHaveLength(5);
  expect(res.error).toContain("8 processes match");
  expect(res.error).toContain("pid 100");
  expect(res.error).not.toContain("pid 106");
});

test("pickByMatch fails clearly when nothing matches", () => {
  const res = pickByMatch([proc(1, 0, "sleep 5")], "vite");
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toContain("no process started in this session");
});

const psLines = (n: number) =>
  Array.from({ length: n }, (_, i) => `${1000 + i} 1 100 worker-${i}`).join("\n");

test("findTagged inspects at most maxInspected processes", async () => {
  let reads = 0;
  const found = await findTagged("s", 0, {
    maxInspected: 50,
    listPs: async () => psLines(500),
    readEnviron: async () => (reads++, ""),
  });
  expect(found).toEqual([]);
  expect(reads).toBe(50);
});

test("findTagged reports at most maxReported processes", async () => {
  const found = await findTagged("s", 0, {
    maxReported: 3,
    listPs: async () => psLines(30),
    readEnviron: async () => `${SESSION_TAG_ENV}=s`,
  });
  expect(found).toHaveLength(3);
});

test("findTagged stops when the time budget is used and returns what it has", async () => {
  let t = 0;
  const found = await findTagged("s", 0, {
    budgetMs: 100,
    now: () => t,
    listPs: async () => psLines(30),
    readEnviron: async () => ((t += 40), `${SESSION_TAG_ENV}=s`),
  });
  expect(found.length).toBe(3);
});
