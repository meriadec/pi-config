import { expect, test } from "bun:test";
import { ActiveWaits } from "./active.ts";
import type { PrView } from "./conditions.ts";
import { cancelWait, executeWait, listWaits, type WaitEnv } from "./execute.ts";
import type { TaggedProcess } from "./procscan.ts";
import { sleep } from "./until.ts";

const PR = "https://github.com/o/r/pull/7";

function setup(opts: { views?: PrView[]; tagged?: TaggedProcess[]; alive?: () => boolean } = {}) {
  let i = 0;
  let changes = 0;
  const env: WaitEnv = {
    conditions: {
      now: Date.now,
      prView: async () => opts.views![Math.min(i++, opts.views!.length - 1)]!,
      isAlive: opts.alive ?? (() => true),
      probeHttp: async () => false,
    },
    until: { sleep: async () => {} },
    active: new ActiveWaits(),
    findTagged: async () => opts.tagged ?? [],
    onChange: () => void changes++,
  };
  return { env, changes: () => changes };
}

const textOf = (r: { content: [{ text: string }] }) => r.content[0].text;

test("wait_for blocks until the PR is merged, then returns and tells the agent to go on", async () => {
  const { env } = setup({ views: [{ state: "OPEN" }, { state: "OPEN" }, { state: "MERGED" }] });
  const res = await executeWait({ event: "pr.merged", pr: PR, note: "then rebase" }, env);
  expect(res.isError).toBe(false);
  expect(res.details.outcome).toBe("done");
  expect(textOf(res)).toContain("merged");
  expect(textOf(res)).toContain("Note: then rebase");
  expect(textOf(res)).toContain("go on with your instructions");
});

test("the active list and the status hook cover exactly the time of the wait", async () => {
  const views: PrView[] = [{ state: "OPEN" }, { state: "MERGED" }];
  const { env, changes } = setup({ views });
  const seen: number[] = [];
  env.until = { sleep: async () => void seen.push(env.active.list().length) };
  await executeWait({ event: "pr.merged", pr: PR }, env);
  expect(seen).toEqual([1]);
  expect(env.active.list()).toEqual([]);
  expect(changes()).toBe(2);
});

test("an abort signal (the Stop button) ends the wait as cancelled and clears it", async () => {
  const { env } = setup({ views: [{ state: "OPEN" }] });
  env.until = { sleep };
  const ctl = new AbortController();
  const p = executeWait({ event: "pr.merged", pr: PR }, env, ctl.signal);
  await Bun.sleep(5);
  expect(env.active.list()).toHaveLength(1);
  ctl.abort();
  const res = await p;
  expect(res.details.outcome).toBe("cancelled");
  expect(res.isError).toBe(false);
  expect(env.active.list()).toEqual([]);
});

test("wait_cancel by id ends the blocked wait", async () => {
  const { env } = setup({ views: [{ state: "OPEN" }] });
  env.until = { sleep };
  const p = executeWait({ event: "pr.merged", pr: PR }, env);
  await Bun.sleep(5);
  expect(textOf(await listWaits(env))).toContain("w1: PR#7 merged");
  expect(textOf(cancelWait("w1", env))).toContain("Cancelled w1");
  expect((await p).details.outcome).toBe("cancelled");
  expect(textOf(cancelWait("w1", env))).toContain("No wait");
});

test("a gh failure that repeats returns an error result", async () => {
  const { env } = setup();
  env.conditions.prView = async () => {
    throw new Error("gh: not logged in");
  };
  const res = await executeWait({ event: "pr.merged", pr: PR }, env);
  expect(res.isError).toBe(true);
  expect(textOf(res)).toContain("not logged in");
  expect(env.active.list()).toEqual([]);
});

test("process.exit with match resolves the one tagged process to a pid", async () => {
  let alive = true;
  const { env } = setup({
    tagged: [{ pid: 77, ppid: 1, ageSeconds: 60, command: "node vite --port 5173" }],
    alive: () => alive,
  });
  env.until = { sleep: async () => void (alive = false) };
  const res = await executeWait({ event: "process.exit", match: "vite" }, env);
  expect(res.isError).toBe(false);
  expect(textOf(res)).toContain("pid 77");
});

test("process.exit with an ambiguous match returns an error with candidates and waits not", async () => {
  const tagged = [1, 2, 3].map((i) => ({
    pid: i,
    ppid: 99,
    ageSeconds: 5,
    command: `node vite-${i}`,
  }));
  const { env } = setup({ tagged });
  const res = await executeWait({ event: "process.exit", match: "vite" }, env);
  expect(res.isError).toBe(true);
  expect(res.details.error).toContain("3 processes match");
  expect(textOf(res)).toContain("pid 2");
  expect(env.active.list()).toEqual([]);
});

test("a bad spec returns an error and starts nothing", async () => {
  const { env, changes } = setup();
  const res = await executeWait({ event: "pr.merged", pr: "#7" }, env);
  expect(res.isError).toBe(true);
  expect(changes()).toBe(0);
});

test("a queued message (finished delegate) ends a time wait early", async () => {
  const { env } = setup();
  let pending = false;
  env.until = { sleep };
  env.hasPending = () => pending;
  env.pendingPollMs = 5;
  const p = executeWait({ event: "time", afterMs: 60_000 }, env);
  await Bun.sleep(20);
  pending = true;
  const res = await p;
  expect(res.details.outcome).toBe("done");
  expect(textOf(res)).toContain("ended early");
  expect(env.active.list()).toEqual([]);
});
