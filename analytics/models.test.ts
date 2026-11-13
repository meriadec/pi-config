import { expect, test } from "bun:test";
import type { MessageUsage } from "./cost.ts";
import {
  buildReport,
  cellStats,
  dominantModel,
  findCorrection,
  formatReport,
  matched,
  toSession,
  turnBand,
  type ModelSessionInput,
} from "./models.ts";

const T0 = Date.UTC(2026, 8, 5); // 2026-09
const OCT = Date.UTC(2026, 9, 5);
const u = (model: string, output = 1000): MessageUsage => ({
  file: "f",
  model,
  input: 1000,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  notional: 0,
});
let id = 0;
const sess = (
  model: string,
  o: {
    turns?: number;
    start?: number;
    label?: string;
    extra?: string[];
    output?: number;
    users?: number;
    last?: string[];
  } = {},
): ModelSessionInput => ({
  file: `s${id++}`,
  label: o.label ?? "implement",
  usage: [
    ...Array.from({ length: o.turns ?? 5 }, () => u(model, o.output)),
    ...(o.extra ?? []).map((m) => u(m)),
  ],
  timestamps: [o.start ?? T0, (o.start ?? T0) + 60_000],
  toolResults: 10,
  toolErrors: 1,
  aborts: 0,
  stopErrors: 0,
  userMessages: o.users ?? 2,
  lastUsers: o.last ?? [],
});
const many = (n: number, model: string, o: Parameters<typeof sess>[1] = {}) =>
  Array.from({ length: n }, () => sess(model, o));

test("session model is the one with most assistant turns; a switch is flagged", () => {
  const s = toSession(sess("claude-opus-5-5", { turns: 3, extra: ["gpt-5-5", "gpt-5-5"] }));
  expect(s.model).toBe("claude-opus-5-5");
  expect(s.switched).toBe(true);
  const t = toSession(sess("claude-opus-5-5", { turns: 1, extra: ["gpt-5-5", "gpt-5-5"] }));
  expect(t.model).toBe("gpt-5-5");
  expect(dominantModel(["b", "a"])).toBe("a");
});

test("switching sessions are excluded from the comparison but counted", () => {
  const inputs = [
    ...many(15, "claude-opus-5-5"),
    ...many(2, "claude-opus-5-5", { turns: 3, extra: ["gpt-5-5", "gpt-5-5"] }),
  ];
  const r = buildReport(inputs);
  expect(r.cells[0]!.sessions).toBe(15);
  expect(r.switched[0]).toEqual({ label: "implement", sessions: 2, of: 17 });
});

test("cells under 15 sessions are dropped", () => {
  expect(buildReport(many(14, "claude-opus-5-5")).cells).toHaveLength(0);
  expect(buildReport(many(15, "claude-opus-5-5")).cells).toHaveLength(1);
});

test("an unpriced model gives null cost, never zero, and stays out of cost stats", () => {
  const s = toSession(sess("no-such-model-9"));
  expect(s.cost).toBeNull();
  const mixed = toSession(sess("claude-opus-5-5", { turns: 3, extra: ["no-such-model-9"] }));
  expect(mixed.cost).toBeNull();
  const allUnpriced = buildReport(many(15, "no-such-model-9"));
  expect(allUnpriced.cells[0]!.medCost).toBeNull();
  expect(allUnpriced.cells[0]!.unpriced).toBe(15);
  expect(formatReport(allUnpriced)).toContain("unpriced");
  const some = cellStats("l", "m", [
    toSession(sess("claude-opus-5-5")),
    toSession(sess("no-such-model-9")),
  ]);
  expect(some.sessions).toBe(2);
  expect(some.medCost).toBeGreaterThan(0);
  expect(some.unpriced).toBe(1);
});

test("matched comparison uses only cells with the same month and turn band", () => {
  // A cheap in Sep, B costly in Oct only: no shared cell, no comparison.
  const apart = [
    ...many(5, "claude-sonnet-5-5", { start: T0 }),
    ...many(5, "claude-opus-5-5", { start: OCT }),
  ].map(toSession);
  expect(matched(apart, "claude-sonnet-5-5", "claude-opus-5-5").weight).toBe(0);
  // Same month, but different turn bands: still no shared cell.
  const bands = [
    ...many(5, "claude-sonnet-5-5", { turns: 5 }),
    ...many(5, "claude-opus-5-5", { turns: 50 }),
  ].map(toSession);
  expect(matched(bands, "claude-sonnet-5-5", "claude-opus-5-5").weight).toBe(0);
  // Same month and band: compare. Cost ratio is cheap/costly of that cell.
  const same = [
    ...many(4, "claude-sonnet-5-5", { output: 1000 }),
    ...many(3, "claude-opus-5-5", { output: 1000 }),
    ...many(5, "claude-opus-5-5", { start: OCT, output: 99_000 }), // other month must not leak in
  ].map(toSession);
  const m = matched(same, "claude-sonnet-5-5", "claude-opus-5-5");
  expect(m.cells).toBe(1);
  expect(m.weight).toBe(3);
  const a = same[0]!.cost!;
  const b = same[4]!.cost!;
  expect(m.costRatio).toBeCloseTo(a / b, 9);
  expect(a).toBeLessThan(b);
});

test("a verdict claims saving only with enough matched sessions", () => {
  const costly = (n: number) => many(n, "claude-opus-5-5", { output: 20_000 });
  const cheap = (n: number) => many(n, "claude-sonnet-5-5", { output: 1000 });
  const yes = buildReport([...costly(25), ...cheap(25)]).verdicts[0]!;
  expect(yes.claim).toBe(true);
  expect(yes.cheap).toBe("claude-sonnet-5-5");
  expect(yes.savedAll).toBeGreaterThan(0);
  // 15 each: eligible, but only 15 matched sessions < 20.
  const no = buildReport([...costly(15), ...cheap(15)]).verdicts[0]!;
  expect(no.claim).toBe(false);
  expect(no.savedAll).toBe(0);
  // Cheaper but more user steering: no claim.
  const worse = buildReport([
    ...costly(25),
    ...many(25, "claude-sonnet-5-5", { output: 1000, users: 9 }),
  ]).verdicts[0]!;
  expect(worse.claim).toBe(false);
});

test("turn bands and month", () => {
  expect([turnBand(10), turnBand(11), turnBand(30), turnBand(31), turnBand(81)]).toEqual([
    "01-10",
    "11-30",
    "11-30",
    "31-80",
    "81+",
  ]);
  expect(toSession(sess("m", { start: OCT })).month).toBe("2026-10");
});

test("keyword proxy: strong words and a leading no match; 'no need' and old messages do not", () => {
  expect(findCorrection(["ok", "no, that's wrong"])?.snippet).toContain("wrong");
  expect(findCorrection(["please revert it"])).not.toBeNull();
  expect(findCorrection(["no need to run tests"])).toBeNull();
  expect(findCorrection(["undo this", "ok", "fine", "thanks"])).toBeNull(); // outside last 3
  expect(
    findCorrection(["x".repeat(200) + " wrong " + "y".repeat(200)])!.snippet.length,
  ).toBeLessThanOrEqual(80);
});

test("month share sums to 100% per month", () => {
  const r = buildReport([...many(3, "a"), ...many(1, "b"), ...many(2, "a", { start: OCT })]);
  const sep = r.monthShare.find((m) => m.month === "2026-09")!;
  expect(sep.share["a"]).toBeCloseTo(0.75, 9);
  expect(sep.share["b"]).toBeCloseTo(0.25, 9);
});
