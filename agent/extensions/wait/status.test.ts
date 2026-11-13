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
  expect(statusLine([t], 0)).toBe(`⏳ timer until ${at(90_000)}`);
});

test("process, url and PR watches show together; extra waits are counted", () => {
  const list = [
    w("w1", { event: "process.exit", label: "vite", pid: 1 }),
    w("w2", { event: "http.ready", url: "http://localhost:3000" }),
    w("w3", { event: "time", afterMs: 5000 }),
    w("w4", { event: "time", afterMs: 5000 }),
  ];
  expect(statusLine(list, 2)).toBe(
    `⏳ waiting for vite to exit · waiting for localhost:3000 · timer until ${at(5000)} · +1 · 2 PR watches`,
  );
});
