import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { describeLeftovers, findTagged, hasTag, parsePs, SESSION_TAG_ENV } from "./procscan.ts";

test("hasTag matches the exact session id only", () => {
  expect(hasTag(`A=1\0${SESSION_TAG_ENV}=abc\0B=2`, "abc")).toBe(true);
  expect(hasTag(`${SESSION_TAG_ENV}=abcd`, "abc")).toBe(false);
});

test("parsePs reads pid, age and command", () => {
  expect(parsePs("  12  345 node server.js --port 3000\n")).toEqual([
    { pid: 12, ageSeconds: 345, command: "node server.js --port 3000" },
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
  expect(describeLeftovers([{ pid: 1, ageSeconds: 600, command: "pnpm dev" }])).toContain(
    "pid 1, up 10 min: pnpm dev",
  );
});
