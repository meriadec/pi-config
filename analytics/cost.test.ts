import { expect, test } from "bun:test";
import { computeCost, costBySession, summarizeCost, type MessageUsage } from "./cost.ts";
import type { PriceTable } from "./prices.ts";

const T: PriceTable = {
  m: { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5 },
  tiered: {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 1,
    tiers: [{ inputTokensAbove: 100, input: 5, output: 6, cacheRead: 0.5, cacheWrite: 5 }],
  },
};

test("prices each token kind per million", () => {
  expect(computeCost({ input: 1e6 }, "m", T)).toBe(10);
  expect(computeCost({ output: 1e6 }, "m", T)).toBe(40);
  expect(computeCost({ cacheRead: 1e6 }, "m", T)).toBe(1);
  expect(computeCost({ cacheWrite: 1e6 }, "m", T)).toBe(12.5);
  expect(computeCost({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }, "m", T)).toBe(
    63.5,
  );
});

test("cache read is cheaper than the same tokens as fresh input", () => {
  const cached = computeCost({ cacheRead: 1e6 }, "m", T)!;
  const fresh = computeCost({ input: 1e6 }, "m", T)!;
  expect(cached).toBeLessThan(fresh);
});

test("unpriced model gives undefined, not zero", () => {
  expect(computeCost({ input: 1e6 }, "nope", T)).toBeUndefined();
});

test("reasoning tokens are not added on top of output", () => {
  expect(computeCost({ output: 1000, reasoning: 800 }, "m", T)).toBe(
    computeCost({ output: 1000 }, "m", T),
  );
});

test("long prompts use the higher tier, counting cache tokens in the prompt", () => {
  expect(computeCost({ input: 100 }, "tiered", T)).toBeCloseTo(100 / 1e6);
  expect(computeCost({ input: 50, cacheRead: 51 }, "tiered", T)).toBeCloseTo(
    (50 * 5 + 51 * 0.5) / 1e6,
  );
});

const msg = (o: Partial<MessageUsage>): MessageUsage => ({
  file: "f",
  model: "m",
  notional: 0,
  ...o,
});

test("summary separates unpriced tokens and computes ratio only for priced models", () => {
  const s = summarizeCost(
    [
      msg({ input: 1e6, notional: 5 }),
      msg({ model: "nope", output: 300, notional: 1 }),
      msg({ model: "nope", input: 100 }),
    ],
    T,
  );
  expect(s.total).toBe(10);
  expect(s.tokens).toBe(1e6 + 400);
  expect(s.unpricedTokens).toBe(400);
  const m = s.byModel.find((x) => x.model === "m")!;
  const n = s.byModel.find((x) => x.model === "nope")!;
  expect(m.ratio).toBe(2);
  expect(n.priced).toBe(false);
  expect(n.ratio).toBeUndefined();
  expect(n.tokens).toBe(400);
});

test("per-session cost keeps unpriced tokens apart from priced cost", () => {
  const r = costBySession(
    [
      msg({ file: "a", input: 1e6 }),
      msg({ file: "a", model: "nope", input: 7 }),
      msg({ file: "b", output: 1e6 }),
    ],
    T,
  );
  expect(r.get("a")).toEqual({ cost: 10, unpricedTokens: 7 });
  expect(r.get("b")).toEqual({ cost: 40, unpricedTokens: 0 });
});

test("provider spellings of one model are merged in the by-model summary", () => {
  const s = summarizeCost([msg({ model: "x/m", input: 1 }), msg({ model: "m", input: 1 })], T);
  expect(s.byModel).toHaveLength(1);
  expect(s.byModel[0]!.messages).toBe(2);
});

test("gpt-5.5 prompt above 272k tokens uses the long-context tier (session logs billed it flat)", () => {
  // Real shape: github-copilot gpt-5.5 message, 300k prompt.
  const u = { input: 20_000, output: 2_000, cacheRead: 280_000, cacheWrite: 0 };
  const flat = (20_000 * 5 + 2_000 * 30 + 280_000 * 0.5) / 1e6; // what the notional log shows
  const tier = (20_000 * 10 + 2_000 * 45 + 280_000 * 1) / 1e6; // OpenAI public long-context price
  expect(computeCost(u, "gpt-5.5")).toBeCloseTo(tier, 10);
  expect(computeCost(u, "gpt-5.5")).not.toBeCloseTo(flat, 3);
  // At exactly 272k the base price still applies.
  expect(computeCost({ input: 272_000 }, "gpt-5.5")).toBeCloseTo((272_000 * 5) / 1e6, 10);
});
