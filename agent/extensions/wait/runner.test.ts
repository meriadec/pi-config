import { expect, test } from "bun:test";
import {
  LocalRunner,
  MAX_LOCAL_WAITS,
  TICK_MS,
  type LocalWait,
  type RunnerDeps,
} from "./runner.ts";

function harness(opts: { alive?: Set<number>; httpUp?: () => boolean } = {}) {
  let now = 0;
  const alive = opts.alive ?? new Set<number>();
  const fired: string[] = [];
  let timers = 0;
  const deps: RunnerDeps = {
    now: () => now,
    isAlive: (pid) => alive.has(pid),
    probeHttp: async () => opts.httpUp?.() ?? false,
    setInterval: () => ++timers,
    clearInterval: () => void timers--,
    fire: (_w: LocalWait, message: string) => void fired.push(message),
  };
  return {
    runner: new LocalRunner(deps),
    fired,
    alive,
    advance: (ms: number) => void (now += ms),
    timers: () => timers,
  };
}

test("fires once when the process exits, not before", async () => {
  const h = harness({ alive: new Set([42]) });
  h.runner.add({ event: "process.exit", label: "vite", pid: 42 });
  h.advance(TICK_MS);
  await h.runner.tick();
  expect(h.fired).toEqual([]);
  h.alive.delete(42);
  h.advance(0);
  h.advance(5 * 60_000);
  await h.runner.tick();
  await h.runner.tick();
  expect(h.fired).toEqual(["Process vite (pid 42) exited after 5 min."]);
  expect(h.runner.list()).toEqual([]);
});

test("http wait fires when the URL answers", async () => {
  let up = false;
  const h = harness({ httpUp: () => up });
  h.runner.add({ event: "http.ready", url: "http://localhost:3000" });
  await h.runner.tick();
  expect(h.fired).toEqual([]);
  up = true;
  await h.runner.tick();
  expect(h.fired[0]).toContain("http://localhost:3000 answers");
});

test("timer wait fires after its delay and keeps the note", async () => {
  const h = harness();
  h.runner.add({ event: "time", afterMs: 30_000 }, { note: "check the deploy" });
  h.advance(29_000);
  await h.runner.tick();
  expect(h.fired).toEqual([]);
  h.advance(1_000);
  await h.runner.tick();
  expect(h.fired[0]).toContain("check the deploy");
});

test("short waits report seconds, not a rounded minute", async () => {
  const h = harness();
  h.runner.add({ event: "process.exit", label: "x", pid: 9 });
  h.advance(12_000);
  await h.runner.tick();
  expect(h.fired[0]).toBe("Process x (pid 9) exited after 12 s.");
});

test("a wait that never happens gives up at the deadline", async () => {
  const h = harness({ alive: new Set([7]) });
  h.runner.add({ event: "process.exit", label: "x", pid: 7 }, { timeoutMs: 60_000 });
  h.advance(61_000);
  await h.runner.tick();
  expect(h.fired[0]).toContain("gave up");
});

test("the polling timer runs only while waits exist", async () => {
  const h = harness({ alive: new Set([1]) });
  const w = h.runner.add({ event: "process.exit", label: "a", pid: 1 });
  expect(h.timers()).toBe(1);
  h.runner.cancel(w.id);
  expect(h.timers()).toBe(0);
});

test("refuses more waits than the cap", () => {
  const h = harness();
  for (let i = 0; i < MAX_LOCAL_WAITS; i++) h.runner.add({ event: "time", afterMs: 1000 });
  expect(() => h.runner.add({ event: "time", afterMs: 1000 })).toThrow("too many active waits");
});
