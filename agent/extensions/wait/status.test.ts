import { expect, test } from "bun:test";
import type { LocalWait } from "./runner.ts";
import { statusLine } from "./status.ts";

const w = (id: string, spec: LocalWait["spec"]): LocalWait => ({
  id,
  spec,
  createdAt: 0,
  deadline: 1e9,
});

test("no waits gives no status", () => {
  expect(statusLine([], 0, 0)).toBeUndefined();
});

test("a timer shows its time left and counts down", () => {
  const t = w("w1", { event: "time", afterMs: 90_000 });
  expect(statusLine([t], 0, 0)).toBe("⏳ timer 1:30");
  expect(statusLine([t], 0, 31_000)).toBe("⏳ timer 0:59");
});

test("process, url and PR watches show together; extra waits are counted", () => {
  const list = [
    w("w1", { event: "process.exit", label: "vite", pid: 1 }),
    w("w2", { event: "http.ready", url: "http://localhost:3000" }),
    w("w3", { event: "time", afterMs: 5000 }),
    w("w4", { event: "time", afterMs: 5000 }),
  ];
  expect(statusLine(list, 2, 65_000)).toBe(
    "⏳ vite exit 1:05 · localhost:3000 1:05 · timer 0:00 · +1 · 2 PR watches",
  );
});
