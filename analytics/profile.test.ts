import { expect, test } from "bun:test";
import { buildProfile, median, percentile, type SessionProfileInput } from "./profile.ts";

const s = (o: Partial<SessionProfileInput>): SessionProfileInput => ({
  label: "implement",
  origin: "human",
  assistantTurns: 0,
  toolCalls: 0,
  toolResults: 0,
  errors: 0,
  toolingErrors: 0,
  readBytes: 0,
  rereadBytes: 0,
  retryLoops: 0,
  delegateCalls: 0,
  ...o,
});

test("median and p90 of turns", () => {
  const rows = buildProfile([1, 2, 3, 4, 100].map((t) => s({ assistantTurns: t })));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.turnsMedian).toBe(3);
  expect(rows[0]!.turnsP90).toBe(100);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
});

test("splits by label and by origin", () => {
  const rows = buildProfile([
    s({ origin: "human" }),
    s({ origin: "human" }),
    s({ origin: "delegated-child" }),
    s({ label: "design" }),
  ]);
  const get = (l: string, o: string) => rows.find((r) => r.label === l && r.origin === o)?.sessions;
  expect(rows).toHaveLength(3);
  expect(get("implement", "human")).toBe(2);
  expect(get("implement", "delegated-child")).toBe(1);
  expect(get("design", "human")).toBe(1);
});

test("error rates are pooled over tool results, not averaged per session", () => {
  const [r] = buildProfile([
    s({ toolResults: 10, errors: 5, toolingErrors: 1 }),
    s({ toolResults: 90, errors: 5, toolingErrors: 3 }),
  ]);
  expect(r!.errorRate).toBeCloseTo(0.1);
  expect(r!.toolingErrorRate).toBeCloseTo(0.04);
});

test("per-session means, MB and loops per 100 sessions", () => {
  const [r] = buildProfile([
    s({ toolCalls: 10, readBytes: 3e6, rereadBytes: 1e6, retryLoops: 1, delegateCalls: 2 }),
    s({ toolCalls: 20, readBytes: 1e6, rereadBytes: 0, retryLoops: 0, delegateCalls: 0 }),
  ]);
  expect(r!.toolCallsPerSession).toBe(15);
  expect(r!.readMbPerSession).toBe(2);
  expect(r!.rereadMbPerSession).toBe(0.5);
  expect(r!.loopsPer100).toBe(50);
  expect(r!.delegatesPerSession).toBe(1);
});

test("zero tool results gives zero rate, not NaN", () => {
  expect(buildProfile([s({})])[0]!.errorRate).toBe(0);
});
