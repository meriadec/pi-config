import { expect, test } from "bun:test";
import { normalizeModelId, priceFor, PRICES } from "./prices.ts";

test("normalizes provider prefixes, dates and dots", () => {
  expect(normalizeModelId("anthropic/claude-opus-4.8")).toBe("claude-opus-4-8");
  expect(normalizeModelId("claude-opus-4-8")).toBe("claude-opus-4-8");
  expect(normalizeModelId("openrouter/anthropic/claude-sonnet-5.5")).toBe("claude-sonnet-5-5");
  expect(normalizeModelId("claude-sonnet-5-20250929")).toBe("claude-sonnet-5");
  expect(normalizeModelId("gpt-5.5-2025-08-07")).toBe("gpt-5-5");
  // four digits are a variant, not a date
  expect(normalizeModelId("deepseek/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash-0731");
});

test("same model under different provider spellings gets one price", () => {
  const a = priceFor("claude-opus-4.8");
  expect(a).toBeDefined();
  expect(priceFor("anthropic/claude-opus-4-8")).toEqual(a);
});

test("unknown model and routed 'auto' are unpriced, not zero", () => {
  expect(priceFor("no-such-model-xyz")).toBeUndefined();
  expect(priceFor("auto")).toBeUndefined();
  expect(priceFor(undefined)).toBeUndefined();
});

test("every table entry has a source and finite non-negative prices", () => {
  for (const [id, p] of Object.entries(PRICES)) {
    expect(p.source, id).toBeTruthy();
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const)
      expect(p[k] >= 0 && Number.isFinite(p[k]), `${id}.${k}`).toBe(true);
  }
});
