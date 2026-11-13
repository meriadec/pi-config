import { expect, test } from "bun:test";
import { detectPolling } from "./polling.ts";
import { ProcessRegistry, looksLongLived, mayStartBackground } from "./registry.ts";
import { chooseRoute, registerWait, type T3Ports } from "./route.ts";
import { parseWaitSpec } from "./spec.ts";

const PR = "https://github.com/o/r/pull/7";

function fakeT3() {
  const calls: string[] = [];
  const t3: T3Ports = {
    watchPullRequest: async (u) => void calls.push(`watch ${u}`),
    scheduleOnce: async (at) => void calls.push(`schedule ${at}`),
    sendToThread: async (m) => void calls.push(`send ${m}`),
  };
  return { calls, t3 };
}

test("a PR review wait is delegated to T3 watch_pull_request", async () => {
  const { calls, t3 } = fakeT3();
  const route = await registerWait(parseWaitSpec({ event: "pr.review", pr: PR }), t3, () => 0);
  expect(route.via).toBe("t3.watch_pull_request");
  expect(calls).toEqual([`watch ${PR}`]);
});

test("a long timer uses T3 schedule_task at now + delay", async () => {
  const { calls, t3 } = fakeT3();
  await registerWait({ event: "time", afterMs: 120_000 }, t3, () => 0);
  expect(calls).toEqual(["schedule 1970-01-01T00:02:00.000Z"]);
});

test("the router splits timers at 60 s: 59_999 ms local, 60_000 ms T3", () => {
  expect(chooseRoute({ event: "time", afterMs: 59_999 }).via).toBe("local-runner");
  expect(chooseRoute({ event: "time", afterMs: 60_000 }).via).toBe("t3.schedule_task");
});

test("registerWait sends no schedule for a local timer", async () => {
  const { calls, t3 } = fakeT3();
  await registerWait({ event: "time", afterMs: 59_999 }, t3, () => 0);
  expect(calls).toEqual([]);
});

test("registerWait computes runAt from now() + afterMs", async () => {
  const { calls, t3 } = fakeT3();
  await registerWait({ event: "time", afterMs: 90_000 }, t3, () =>
    Date.UTC(2026, 10, 12, 10, 0, 0),
  );
  expect(calls).toEqual(["schedule 2026-11-12T10:01:30.000Z"]);
});

test("pr.merged is not a wait event", () => {
  expect(() => parseWaitSpec({ event: "pr.merged", pr: PR })).toThrow("unknown event");
});

test("process and http waits need the local runner", () => {
  expect(chooseRoute({ event: "process.exit", label: "vite", pid: 1 }).via).toBe("local-runner");
  expect(chooseRoute({ event: "http.ready", url: "http://localhost:3000" }).via).toBe(
    "local-runner",
  );
});

test("a malformed spec fails with a clear message", () => {
  expect(() => parseWaitSpec({ event: "pr.review", pr: "#7" })).toThrow(
    "full GitHub pull request URL",
  );
  expect(() => parseWaitSpec({ event: "nope" })).toThrow("unknown event");
});

test("detects hand-made polling but not normal commands", () => {
  expect(detectPolling("while true; do gh pr view 7 --json reviews; sleep 30; done")).toBe(
    "gh-poll",
  );
  expect(detectPolling("until curl -sf localhost:3000; do sleep 2; done")).toBe("sleep-loop");
  expect(detectPolling("watch -n 5 gh pr checks 7")).toBe("watch-cmd");
  expect(detectPolling("gh pr view 7 --json reviews")).toBeUndefined();
  expect(detectPolling("sleep 1200")).toBe("long-sleep");
  expect(detectPolling("sleep 15; kubectl get pods")).toBeUndefined();
  expect(detectPolling("sleep 19")).toBeUndefined();
  expect(detectPolling("sleep 20; kubectl get pods")).toBe("long-sleep");
  expect(detectPolling("sleep 29")).toBe("long-sleep");
  expect(detectPolling("sleep 25 && echo ok")).toBe("long-sleep");
  expect(detectPolling("timeout 120 sleep 90")).toBe("long-sleep");
  expect(detectPolling("timeout -s KILL 120 sleep 90")).toBe("long-sleep");
  expect(detectPolling("bash -c 'sleep 45; echo done'")).toBe("long-sleep");
  expect(detectPolling('sh -c "sleep 300"')).toBe("long-sleep");
  expect(detectPolling("timeout 5 sleep 3")).toBeUndefined();
  expect(detectPolling("bash -c 'sleep 5'")).toBeUndefined();
  expect(
    detectPolling("cat > f <<'E'\nwhile true; do gh pr view; sleep 30; done\nE"),
  ).toBeUndefined();
  expect(detectPolling("sleep 1")).toBeUndefined();
  expect(detectPolling("echo sleep 30 is long")).toBeUndefined();
});

test("registry reports live processes only", () => {
  const r = new ProcessRegistry();
  r.register({ pid: 1, label: "vite", command: "pnpm dev", startedAt: 0 });
  r.register({ pid: 2, label: "tests", command: "bun test --watch", startedAt: 0 });
  r.markExited(2, 10);
  expect(r.endOfTurnNote(600_000)).toContain("pid 1 vite (up 10 min)");
  expect(r.endOfTurnNote(600_000)).not.toContain("pid 2");
  r.markExited(1, 20);
  expect(r.endOfTurnNote(600_000)).toBe("");
  expect(looksLongLived("pnpm dev")).toBe(true);
  expect(looksLongLived("git status")).toBe(false);
});

test("background markers: ' &', nohup, setsid, disown, long-lived commands", () => {
  expect(mayStartBackground("pnpm x > log 2>&1 &")).toBe(true);
  expect(mayStartBackground("nohup ./run")).toBe(true);
  expect(mayStartBackground("setsid foo")).toBe(true);
  expect(mayStartBackground("foo; disown")).toBe(true);
  expect(mayStartBackground("pnpm dev")).toBe(true);
  expect(mayStartBackground("ls -la && git status")).toBe(false);
  expect(mayStartBackground("echo a 2>&1 | head")).toBe(false);
  expect(mayStartBackground("cmd &> out.log")).toBe(false);
});
