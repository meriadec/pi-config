import { expect, test } from "bun:test";
import { computeCost, type MessageUsage } from "./cost.ts";
import { priceFor } from "./prices.ts";
import {
  buildTail,
  classifyBash,
  contextCapSaving,
  costSplit,
  partialSpearman,
  ranks,
  repeatReads,
  sessionTail,
  spearman,
  type TailInput,
} from "./tail.ts";

const MODEL = "claude-fable-5";
const p = priceFor(MODEL)!;
const msg = (o: Partial<MessageUsage>): MessageUsage => ({
  file: "f",
  model: MODEL,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  notional: 0,
  ...o,
});

test("cost split puts each token kind at its own price and sums to computeCost", () => {
  const m = msg({ input: 1e6, output: 2e6, cacheRead: 3e6, cacheWrite: 4e6 });
  const s = costSplit([m]);
  // Fable has no tiers at this size; if it ever does, the equality below still holds.
  expect(s.input + s.cacheRead + s.cacheWrite + s.output).toBeCloseTo(computeCost(m, MODEL)!, 9);
  if (!p.tiers) {
    expect(s.input).toBeCloseTo(p.input, 9);
    expect(s.output).toBeCloseTo(2 * p.output, 9);
    expect(s.cacheRead).toBeCloseTo(3 * p.cacheRead, 9);
    expect(s.cacheWrite).toBeCloseTo(4 * p.cacheWrite, 9);
  }
  expect(costSplit([msg({ output: 1e6 })])).toEqual({
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: p.output,
  });
});

test("cost split ignores unpriced models", () => {
  const s = costSplit([msg({ model: "no-such-model-xyz", output: 1e6 })]);
  expect(s.output).toBe(0);
});

test("bash classes: each match counts, chains count twice, plain commands none", () => {
  expect(classifyBash("bun test analytics")).toEqual(["tests"]);
  expect(classifyBash("pnpm lint && pnpm test")).toEqual(["tests", "lint"]);
  expect(classifyBash("sleep 30; gh pr checks 5")).toEqual(["poll", "git"]);
  expect(classifyBash("pnpm dev")).toEqual(["devServer"]);
  expect(classifyBash("pnpm -C app build")).toEqual(["build"]);
  expect(classifyBash("git status")).toEqual(["git"]);
  expect(classifyBash("ls -la")).toEqual([]);
});

test("repeat reads count only reads of a path seen before", () => {
  expect(repeatReads(["a", "b", "a", "a"])).toBe(2);
  expect(repeatReads([])).toBe(0);
});

test("ranks average ties; spearman is monotone-invariant", () => {
  expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  expect(spearman([1, 2, 3, 4], [1, 8, 27, 1000])).toBeCloseTo(1, 9);
  expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
});

test("partial spearman removes what the control explains", () => {
  const turns = Array.from({ length: 40 }, (_, i) => i + 1);
  const cost = turns.map((t) => t * 2);
  const proxy = turns.map((t) => t * 3 + 1); // only a function of turns
  // extra = cost noise that proxy2 tracks, independent of turns rank
  const wiggle = turns.map((_, i) => ((i * 7) % 11) - 5);
  const cost2 = turns.map((t, i) => t * 2 + wiggle[i]! * 0.5);
  expect(spearman(proxy, cost)).toBeCloseTo(1, 9);
  expect(Math.abs(partialSpearman(proxy, cost, turns))).toBeLessThan(0.01);
  expect(partialSpearman(wiggle, cost2, turns)).toBeGreaterThan(0.8);
});

const input = (o: Partial<TailInput> & { n: number; cost: number }): TailInput => ({
  file: `s${o.cost}`,
  label: "implement",
  origin: "human",
  // one message of output-only usage: cost = output tokens * price
  usage: Array.from({ length: o.n }, () => msg({ output: (o.cost * 1e6) / p.output / o.n })),
  toolCalls: {},
  bashCommands: [],
  readPaths: [],
  compactions: 0,
  userMessages: 1,
  aborts: 0,
  toolErrors: 0,
  retryLoops: 0,
  timestamps: [0, 60_000],
  ...o,
});

test("buckets: top5/top20/bottom50 sizes, totals and costs come from the right sessions", () => {
  // 20 sessions with cost 1..20 dollars.
  const sessions = Array.from({ length: 20 }, (_, i) => sessionTail(input({ n: 2, cost: i + 1 })));
  const r = buildTail(sessions);
  expect(r.n).toBe(20);
  expect(r.total).toBeCloseTo(210, 6);
  expect([r.top5.n, r.top20.n, r.bottom50.n]).toEqual([1, 4, 10]);
  expect(r.top5.costTotal).toBeCloseTo(20, 6);
  expect(r.top20.costTotal).toBeCloseTo(20 + 19 + 18 + 17, 6);
  expect(r.bottom50.costTotal).toBeCloseTo(55, 6);
  expect(r.top20.costMedian).toBeCloseTo(18.5, 6);
  expect(r.top20.split.output).toBeCloseTo(r.top20.costTotal, 6);
  expect(r.top.map((s) => s.file)[0]).toBe("s20");
});

test("session features: cost, turns, user msgs, gaps, bash mix", () => {
  const s = sessionTail(
    input({
      n: 4,
      cost: 8,
      userMessages: 2,
      bashCommands: ["bun test", "sleep 5", "git diff"],
      toolCalls: { bash: 3, read: 2, mcp__x__delegate_task: 1 },
      readPaths: ["a", "a"],
      timestamps: [0, 60_000, 60_000 + 10 * 60_000, 11 * 60_000 + 1000],
    }),
  );
  expect(s.cost).toBeCloseTo(8, 6);
  expect(s.f["turns"]).toBe(4);
  expect(s.f["costPerTurn"]).toBeUndefined();
  expect(s.f["userMessages"]).toBe(2);
  expect(s.f["idleGaps5m"]).toBe(1);
  expect(s.f["idleMin"]).toBeCloseTo(10, 6);
  expect(s.f["bash_tests"]).toBe(1);
  expect(s.f["bash_poll"]).toBe(1);
  expect(s.f["bash_git"]).toBe(1);
  expect(s.f["delegateCalls"]).toBe(1);
  expect(s.f["repeatReads"]).toBe(1);
});

test("best feature after turn control is the one that tracks cost beyond turns", () => {
  // Same turns for all; cost grows with user messages only. readCalls is noise.
  const sessions = Array.from({ length: 30 }, (_, i) =>
    sessionTail(
      input({
        n: 5,
        cost: 1 + i,
        userMessages: i + 1,
        toolCalls: { read: (i * 7) % 5 },
      }),
    ),
  );
  const r = buildTail(sessions);
  expect(r.best[0]).toBe("userMessages");
});

test("context cap saves cache-read cost above the cap only", () => {
  const big = msg({ input: 0, cacheRead: 600_000, cacheWrite: 0 });
  const small = msg({ cacheRead: 100_000 });
  const s = input({ n: 2, cost: 1, usage: [big, small] });
  const save = contextCapSaving([s], 300);
  const readCost = costSplit([big]).cacheRead;
  // half the tokens drop; no cacheWrite in this session so no restart charge
  expect(save).toBeCloseTo(readCost * 0.5, 9);
  expect(contextCapSaving([s], 1000)).toBe(0);
});
