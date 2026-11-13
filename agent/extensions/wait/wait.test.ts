import { expect, test } from "bun:test";
import { detectPolling, pollingHint } from "./polling.ts";
import { ProcessRegistry, looksLongLived, mayStartBackground } from "./registry.ts";
import { parseWaitSpec } from "./spec.ts";

const PR = "https://github.com/o/r/pull/7";

test("PR events parse, with an optional reviewer on review events only", () => {
  expect(parseWaitSpec({ event: "pr.merged", pr: PR })).toEqual({ event: "pr.merged", pr: PR });
  expect(parseWaitSpec({ event: "pr.review", pr: PR, reviewer: " copilot " })).toEqual({
    event: "pr.review",
    pr: PR,
    reviewer: "copilot",
  });
  expect(() => parseWaitSpec({ event: "pr.merged", pr: PR, reviewer: "x" })).toThrow("reviewer");
});

test("the old pr.checks event is gone", () => {
  expect(() => parseWaitSpec({ event: "pr.checks", pr: PR })).toThrow("unknown event");
});

test("a malformed spec fails with a clear message", () => {
  expect(() => parseWaitSpec({ event: "pr.review", pr: "#7" })).toThrow(
    "full GitHub pull request URL",
  );
  expect(() => parseWaitSpec({ event: "nope" })).toThrow("unknown event");
  expect(() => parseWaitSpec({ event: "time", afterMs: 0 })).toThrow("afterMs");
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

test("a fixed pause after a background start gets the startup hint", () => {
  expect(detectPolling("(pnpm dev > /tmp/d.log 2>&1 &); sleep 25; curl -s localhost:3000")).toBe(
    "startup-pause",
  );
  expect(detectPolling("nohup node server.js & sleep 30; curl localhost:3000")).toBe(
    "startup-pause",
  );
  expect(detectPolling("sleep 25; kubectl get pods")).toBe("long-sleep");
  expect(pollingHint("startup-pause")).toContain("http.ready");
  expect(pollingHint("startup-pause")).toContain("timeout 60 bash -c");
});

test("a bounded loop with short sleeps is a normal readiness check, an unbounded one is not", () => {
  expect(
    detectPolling("timeout 60 bash -c 'until curl -sf localhost:3000; do sleep 1; done'"),
  ).toBeUndefined();
  expect(detectPolling("until curl -sf localhost:3000; do sleep 1; done")).toBe("sleep-loop");
  expect(
    detectPolling("timeout 600 bash -c 'until curl -sf localhost:3000; do sleep 30; done'"),
  ).toBe("sleep-loop");
  expect(detectPolling("timeout 300 bash -c 'while true; do gh pr view 7; sleep 2; done'")).toBe(
    "gh-poll",
  );
});
