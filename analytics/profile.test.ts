import { readFileSync } from "node:fs";
import { CACHE_FILE, LEGACY_CACHE_FILE } from "./llm-label.ts";
import { expect, test } from "bun:test";
import {
  buildProfile,
  formatProfile,
  labelFor,
  median,
  percentile,
  type SessionProfileInput,
} from "./profile.ts";

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
  cost: 0,
  unpricedTokens: 0,
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

test("cost mean, median and total per group", () => {
  const [r] = buildProfile([1, 2, 9].map((c) => s({ cost: c })));
  expect(r!.costMean).toBe(4);
  expect(r!.costMedian).toBe(2);
  expect(r!.costTotal).toBe(12);
  expect(r!.unpricedSessions).toBe(0);
});

test("sessions with unpriced tokens are counted and marked, not treated as free", () => {
  const rows = buildProfile([s({ cost: 5 }), s({ cost: 0, unpricedTokens: 10 })]);
  expect(rows[0]!.unpricedSessions).toBe(1);
  expect(formatProfile(rows)).toContain("5*");
  expect(formatProfile(buildProfile([s({ cost: 5 })]))).not.toContain("5*");
});

test("profile labels come from the label source given, not an old one", () => {
  const current = new Map([["f1", { label: "diagnose" }]]);
  const stale = new Map([["f1", { label: "implement" }]]);
  const rows = (src: typeof current) =>
    buildProfile([s({ label: labelFor(src, "f1"), cost: 2 }), s({ label: labelFor(src, "f2") })]);
  expect(
    rows(current)
      .map((r) => r.label)
      .sort(),
  ).toEqual(["UNLABELLED", "diagnose"]);
  expect(
    rows(stale)
      .map((r) => r.label)
      .sort(),
  ).toEqual(["UNLABELLED", "implement"]);
});

test("analytics commands read the current label cache, never the legacy one", () => {
  expect(CACHE_FILE.endsWith("llm-labels-v2.jsonl")).toBe(true);
  expect(CACHE_FILE).not.toBe(LEGACY_CACHE_FILE);
  const cli = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
  expect(cli).not.toContain("loadLegacyCache");
  expect(cli).not.toContain("labelByRules");
  expect(cli).not.toContain("LEGACY_CACHE_FILE");
});
