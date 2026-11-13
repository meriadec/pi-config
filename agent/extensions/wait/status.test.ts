import { expect, test } from "bun:test";
import type { LocalWait } from "./runner.ts";
import { statusLine } from "./status.ts";

const w = (id: string, spec: LocalWait["spec"]): LocalWait => ({
  id,
  spec,
  createdAt: 0,
  deadline: 1e9,
});

const at = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

test("no waits gives no status", () => {
  expect(statusLine([], 0)).toBeUndefined();
});

test("a timer shows its end time, and the text never changes while it waits", () => {
  const t = w("w1", { event: "time", afterMs: 90_000 });
  expect(statusLine([t], 0)).toBe(`⏳ 1 wait: ⏰${at(90_000)}`);
});

test("all waits show, count first, so a cut one-line banner still shows the count", () => {
  const list = [
    w("w1", { event: "process.exit", label: "vite", pid: 1 }),
    w("w2", { event: "http.ready", url: "http://localhost:3000" }),
    w("w3", { event: "time", afterMs: 5000 }),
    w("w4", { event: "time", afterMs: 5000 }),
  ];
  expect(statusLine(list, 2)).toBe(
    `⏳ 6 waits: vite exit, localhost:3000 up, ⏰${at(5000)}, ⏰${at(5000)}, 2 PRs`,
  );
});
