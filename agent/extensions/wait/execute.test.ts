import { expect, test } from "bun:test";
import { cancelWait, executeWait, listWaits, RemoteWaits, type WaitEnv } from "./execute.ts";
import type { TaggedProcess } from "./procscan.ts";
import { LocalRunner, type RunnerDeps } from "./runner.ts";

const PR = "https://github.com/o/r/pull/7";
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0);

function setup(opts: { fail?: string; tagged?: TaggedProcess[]; taskResult?: unknown } = {}) {
  const calls: { name: string; args: unknown }[] = [];
  const deps: RunnerDeps = {
    now: () => NOW,
    isAlive: () => true,
    probeHttp: async () => false,
    setInterval: () => 1,
    clearInterval: () => {},
    fire: () => {},
  };
  const runner = new LocalRunner(deps);
  const env: WaitEnv = {
    tools: [
      { name: "mcp__t3-code__watch_pull_request" },
      { name: "mcp__t3-code__unwatch_pull_request" },
      { name: "mcp__t3-code__schedule_task" },
      { name: "mcp__t3-code__delete_scheduled_task" },
    ],
    executeTool: async (name, args) => {
      calls.push({ name, args });
      if (opts.fail && name.endsWith(opts.fail))
        return { isError: true, result: { content: [{ type: "text", text: "boom" }] } };
      return {
        isError: false,
        result: {
          content: [{ type: "text", text: "ok" }],
          structuredContent: opts.taskResult ?? { scheduledTaskId: "scheduled-task:abc" },
        },
      };
    },
    runner: () => runner,
    remote: new RemoteWaits(),
    now: () => NOW,
    findTagged: async () => opts.tagged ?? [],
  };
  return { env, calls, runner };
}

const textOf = (r: { content: [{ text: string }] }) => r.content[0].text;

test("a PR wait calls watch_pull_request and says T3 wakes on ANY event", async () => {
  const { env, calls } = setup();
  const res = await executeWait({ event: "pr.checks", pr: PR }, env);
  expect(calls).toEqual([{ name: "mcp__t3-code__watch_pull_request", args: { url: PR } }]);
  expect(textOf(res)).toContain("ANY event");
  expect(textOf(res)).toContain("p1");
  expect(res.isError).toBe(false);
});

test("a timer of 60 s or more calls schedule_task with runAt = now + afterMs", async () => {
  const { env, calls } = setup();
  const res = await executeWait({ event: "time", afterMs: 90_000, note: "hi" }, env);
  expect(calls[0]?.name).toBe("mcp__t3-code__schedule_task");
  expect(calls[0]?.args).toMatchObject({
    prompt: "hi",
    schedule: { type: "once", runAt: "2026-11-12T10:01:30.000Z" },
  });
  expect(textOf(res)).toContain("t1");
});

test("a timer under 60 s stays local and the text says local waits end with the session", async () => {
  const { env, calls, runner } = setup();
  const res = await executeWait({ event: "time", afterMs: 59_999 }, env);
  expect(calls).toEqual([]);
  expect(runner.list()).toHaveLength(1);
  expect(textOf(res)).toContain("Local waits end when this session ends or reloads");
  expect(textOf(res)).toContain("kept by T3");
});

test("process.exit with match resolves the one tagged process to a pid", async () => {
  const { env, runner } = setup({
    tagged: [{ pid: 77, ppid: 1, ageSeconds: 60, command: "node vite --port 5173" }],
  });
  const res = await executeWait({ event: "process.exit", match: "vite" }, env);
  expect(res.isError).toBe(false);
  expect(runner.list()[0]?.spec).toEqual({ event: "process.exit", label: "vite", pid: 77 });
});

test("process.exit with an ambiguous match returns an error with candidates and adds nothing", async () => {
  const tagged = [1, 2, 3].map((i) => ({
    pid: i,
    ppid: 99,
    ageSeconds: 5,
    command: `node vite-${i}`,
  }));
  const { env, runner } = setup({ tagged });
  const res = await executeWait({ event: "process.exit", match: "vite" }, env);
  expect(res.isError).toBe(true);
  expect(res.details.route).toBe("local-runner");
  expect(res.details.error).toContain("3 processes match");
  expect(textOf(res)).toContain("pid 2");
  expect(runner.list()).toEqual([]);
});

test("process.exit with a pid still works", async () => {
  const { env, runner } = setup();
  await executeWait({ event: "process.exit", pid: 4242, label: "vite" }, env);
  expect(runner.list()[0]?.spec).toEqual({ event: "process.exit", label: "vite", pid: 4242 });
});

test("a T3 failure returns isError with route, tool and error", async () => {
  const { env } = setup({ fail: "watch_pull_request" });
  const res = await executeWait({ event: "pr.review", pr: PR }, env);
  expect(res.isError).toBe(true);
  expect(res.details).toMatchObject({ route: "t3.watch_pull_request", tool: "watch_pull_request" });
  expect(res.details.error).toContain("boom");
  expect(env.remote.list(NOW)).toEqual([]);
});

test("a missing T3 tool returns an error", async () => {
  const { env } = setup();
  const res = await executeWait({ event: "pr.review", pr: PR }, { ...env, tools: [] });
  expect(res.isError).toBe(true);
  expect(res.details.error).toContain("not available");
});

test("wait_list shows PR watches and timers; wait_cancel stops them in T3", async () => {
  const { env, calls } = setup();
  await executeWait({ event: "pr.review", pr: PR }, env);
  await executeWait({ event: "time", afterMs: 120_000 }, env);
  const list = textOf(await listWaits(env));
  expect(list).toContain("p1: PR watch");
  expect(list).toContain("t1: T3 timer");

  calls.length = 0;
  const c1 = await cancelWait("p1", env);
  const c2 = await cancelWait("t1", env);
  expect(c1.isError).toBe(false);
  expect(c2.isError).toBe(false);
  expect(calls).toEqual([
    { name: "mcp__t3-code__unwatch_pull_request", args: { url: PR } },
    {
      name: "mcp__t3-code__delete_scheduled_task",
      args: { scheduledTaskId: "scheduled-task:abc" },
    },
  ]);
  expect(textOf(await listWaits(env))).toContain("No waits");
});

test("a failed cancel keeps the entry and reports route, tool and error", async () => {
  const { env } = setup();
  await executeWait({ event: "time", afterMs: 120_000 }, env);
  const failing = {
    ...env,
    executeTool: async () => ({
      isError: true,
      result: { content: [{ type: "text", text: "nope" }] },
    }),
  };
  const res = await cancelWait("t1", failing);
  expect(res.isError).toBe(true);
  expect(res.details).toMatchObject({ route: "t3", tool: "delete_scheduled_task" });
  expect(env.remote.list(NOW)).toHaveLength(1);
});

test("the task id is parsed from a JSON text result when there is no structured content", async () => {
  const { env, calls } = setup();
  const textOnly = {
    ...env,
    executeTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return {
        isError: false,
        result: { content: [{ type: "text", text: '{"scheduledTaskId":"scheduled-task:zz"}' }] },
      };
    },
  };
  await executeWait({ event: "time", afterMs: 120_000 }, textOnly);
  calls.length = 0;
  await cancelWait("t1", textOnly);
  expect(calls[0]?.args).toEqual({ scheduledTaskId: "scheduled-task:zz" });
});

test("a timer that already ran in T3 leaves wait_list", async () => {
  const { env } = setup();
  await executeWait({ event: "time", afterMs: 120_000 }, env);
  expect(env.remote.list(NOW + 119_000)).toHaveLength(1);
  expect(env.remote.list(NOW + 120_000)).toHaveLength(0);
});

test("wait_cancel cancels a local wait", async () => {
  const { env, runner } = setup();
  await executeWait({ event: "time", afterMs: 1_000 }, env);
  expect((await cancelWait("w1", env)).isError).toBe(false);
  expect(runner.list()).toEqual([]);
  expect(textOf(await cancelWait("w1", env))).toContain("No wait");
});
