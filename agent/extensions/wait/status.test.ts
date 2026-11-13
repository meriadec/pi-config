import { expect, test } from "bun:test";
import { statusLine, waitLabel } from "./status.ts";

const PR = "https://github.com/o/r/pull/7";
const at = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

test("no waits gives no status", () => {
  expect(statusLine([])).toBeUndefined();
});

test("a timer label shows its end time, so the text never changes while it waits", () => {
  expect(waitLabel({ event: "time", afterMs: 90_000 }, 0)).toBe(`⏰${at(90_000)}`);
});

test("PR labels show number, event and reviewer", () => {
  expect(waitLabel({ event: "pr.merged", pr: PR }, 0)).toBe("PR#7 merged");
  expect(waitLabel({ event: "pr.review", pr: PR, reviewer: "copilot" }, 0)).toBe(
    "PR#7 review:copilot",
  );
});

test("count comes first, so a cut one-line banner still shows it", () => {
  expect(statusLine(["vite exit", "PR#7 merged"])).toBe("⏳ 2 waits: vite exit, PR#7 merged");
  expect(statusLine(["PR#7 merged"])).toBe("⏳ 1 wait: PR#7 merged");
});
