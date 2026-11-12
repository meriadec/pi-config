import { expect, test } from "bun:test";
import {
  adjusted,
  bandOf,
  byGroup,
  groupOf,
  ratesOf,
  scanOutcome,
  type SessionOutcome,
} from "./images-impact.ts";

const msg = (m: object) => JSON.stringify({ type: "message", message: m });
const so = (p: Partial<SessionOutcome> = {}): SessionOutcome => ({
  file: "f",
  imageBytes: 0,
  toolResultBytes: 100,
  compactions: 0,
  assistantTurns: 10,
  stopError: 0,
  stopLength: 0,
  aborted: 0,
  toolResults: 10,
  toolErrors: 0,
  overflow: false,
  ...p,
});

test("groupOf: boundaries 0, 20%, 50%", () => {
  expect(groupOf(so({ imageBytes: 0 }))).toBe("none");
  expect(groupOf(so({ imageBytes: 19 }))).toBe("<20%");
  expect(groupOf(so({ imageBytes: 20 }))).toBe("20-50%");
  expect(groupOf(so({ imageBytes: 50 }))).toBe("20-50%");
  expect(groupOf(so({ imageBytes: 51 }))).toBe(">50%");
});

test("bandOf edges", () => {
  expect([1, 30, 31, 100, 101, 300, 301].map(bandOf)).toEqual([
    "1-30",
    "1-30",
    "31-100",
    "31-100",
    "101-300",
    "101-300",
    ">300",
  ]);
});

test("scanOutcome counts turns, stops, errors, compactions, image bytes, overflow", () => {
  const o = scanOutcome("f", [
    JSON.stringify({ type: "compaction" }),
    msg({ role: "assistant", stopReason: "toolUse", content: [] }),
    msg({ role: "assistant", stopReason: "aborted" }),
    msg({ role: "assistant", stopReason: "length" }),
    msg({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model",
    }),
    msg({ role: "toolResult", isError: true, content: [{ type: "text", text: "abcde" }] }),
    msg({ role: "toolResult", content: [{ type: "image", data: "x".repeat(20) }] }),
    msg({ role: "toolResult", content: "plain" }),
    msg({ role: "user", content: [{ type: "image", data: "x".repeat(99) }] }),
    "not json",
  ]);
  expect(o).toEqual({
    file: "f",
    imageBytes: 20,
    toolResultBytes: 30,
    compactions: 1,
    assistantTurns: 4,
    stopError: 1,
    stopLength: 1,
    aborted: 1,
    toolResults: 3,
    toolErrors: 1,
    overflow: true,
  });
});

test("overflow is not set by tool output or by other errors", () => {
  const o = scanOutcome("f", [
    msg({ role: "toolResult", content: "context window", isError: true }),
    msg({ role: "assistant", stopReason: "error", errorMessage: "Request timed out." }),
  ]);
  expect(o.overflow).toBe(false);
});

test("ratesOf: ratios of sums, not mean of ratios", () => {
  const r = ratesOf([
    so({ assistantTurns: 10, stopError: 1, toolResults: 10, toolErrors: 5, compactions: 2 }),
    so({ assistantTurns: 90, stopError: 1, toolResults: 90, toolErrors: 5, overflow: true }),
  ]);
  expect(r.errorStopsPer100).toBe(2);
  expect(r.toolErrorRate).toBe(0.1);
  expect(r.compactionsPerSession).toBe(1);
  expect(r.turnsMean).toBe(50);
  expect(r.turnsMedian).toBe(50);
  expect(r.overflowShare).toBe(0.5);
});

test("byGroup splits sessions into groups", () => {
  const g = byGroup([
    so(),
    so({ imageBytes: 10 }),
    so({ imageBytes: 30 }),
    so({ imageBytes: 90 }),
    so({ imageBytes: 95 }),
  ]);
  expect([g.none.sessions, g["<20%"].sessions, g["20-50%"].sessions, g[">50%"].sessions]).toEqual([
    1, 1, 1, 2,
  ]);
});

test("adjusted removes a confounder: raw gap is large, within-stratum gap is zero", () => {
  const mk = (file: string, img: boolean, comp: number) =>
    so({ file, imageBytes: img ? 30 : 0, compactions: comp });
  // label A has many compactions for everyone; images concentrate in A.
  const sessions = [
    ...Array.from({ length: 10 }, () => mk("A", true, 4)),
    ...Array.from({ length: 5 }, () => mk("A", false, 4)),
    ...Array.from({ length: 1 }, () => mk("B", true, 0)),
    ...Array.from({ length: 20 }, () => mk("B", false, 0)),
  ];
  expect(byGroup(sessions)["20-50%"].compactionsPerSession).toBeGreaterThan(3);
  const a = adjusted(sessions, (s) => s.file);
  expect(a["20-50%"].diff.compactionsPerSession).toBe(0);
  expect(a["20-50%"].strata).toBe(1); // B skipped: only 1 image session
  expect(a["20-50%"].sessions).toBe(10);
});

test("adjusted reports a real within-stratum difference", () => {
  const sessions = [
    ...Array.from({ length: 5 }, () => so({ file: "A", imageBytes: 60, stopError: 2 })),
    ...Array.from({ length: 5 }, () => so({ file: "A" })),
  ];
  expect(adjusted(sessions, (s) => s.file)[">50%"].diff.errorStopsPer100).toBe(20);
});
