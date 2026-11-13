import { expect, test } from "bun:test";
import { formatNudge, loadNudgeLog, replay, type NudgeLine } from "./nudge-replay.ts";

const L = (session: string, tokens: number, turns: number, cost: number | null): NudgeLine => ({
  ts: "2026-01-01T00:00:00Z",
  session,
  tokens,
  turns,
  cost,
});

test("saving grows when the threshold is lower; sessions below cap are not counted", () => {
  const lines = [L("a", 160_000, 50, 10), L("a", 260_000, 80, 30), L("b", 120_000, 20, 2)];
  const r = replay(lines, [100, 300]);
  expect(r[0]!.sessions).toBe(2);
  expect(r[1]!.sessions).toBe(0);
  expect(r[0]!.savingUsd).toBeGreaterThan(0);
  expect(r[1]!.savingUsd).toBe(0);
});

test("exact value for one session", () => {
  // cap 100K: seg1 avg 80K (<cap, crossed by end) no save; seg2 avg 210K, cost 20
  const r = replay([L("a", 160_000, 50, 10), L("a", 260_000, 80, 30)], [100])[0]!;
  const expected = 20 * 0.61 * (110 / 210) - 0.1 * 3.75;
  expect(r.savingUsd).toBeCloseTo(expected, 6);
});

test("loader skips bad lines and missing file", async () => {
  expect(loadNudgeLog("/nonexistent/x.jsonl")).toEqual([]);
  const p = "/tmp/nudge-replay-test.jsonl";
  await Bun.write(
    p,
    'not json\n{"session":"a","tokens":5,"turns":1,"cost":null,"ts":"t"}\n{"x":1}\n',
  );
  expect(loadNudgeLog(p)).toHaveLength(1);
});

test("format states assumptions and handles empty log", () => {
  expect(formatNudge([])).toContain("empty");
  const out = formatNudge([L("a", 160_000, 50, 10)]);
  expect(out).toContain("assumptions:");
  expect(out).toContain("1 sessions crossed");
});
