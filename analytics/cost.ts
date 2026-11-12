/** Cost recomputed at public API prices. Pure: usage rows in, numbers out. */
import { normalizeModelId, priceFor, type PriceTable, PRICES, type Price } from "./prices.ts";

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** Ignored on purpose: `output` already includes reasoning tokens (totalTokens = input+output+cacheRead+cacheWrite). */
  reasoning?: number;
}

const M = 1e6;

function effectivePrice(price: Price, promptTokens: number): Price {
  const tier = price.tiers
    ?.filter((t) => promptTokens > t.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
  return tier ?? price;
}

/** USD for one assistant message. `undefined` when the model has no known price. */
export function computeCost(
  usage: Usage,
  model: string | undefined | null,
  table: PriceTable = PRICES,
): number | undefined {
  const base = priceFor(model, table);
  if (!base) return undefined;
  const u = {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  };
  const p = effectivePrice(base, u.input + u.cacheRead + u.cacheWrite);
  return (
    (u.input * p.input +
      u.output * p.output +
      u.cacheRead * p.cacheRead +
      u.cacheWrite * p.cacheWrite) /
    M
  );
}

export const totalTokens = (u: Usage) =>
  (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

export interface MessageUsage extends Usage {
  file: string;
  model: string;
  /** usage.cost.total as logged (notional). */
  notional: number;
}

export interface ModelCost {
  model: string;
  messages: number;
  tokens: number;
  /** Recomputed USD. 0 for unpriced models: check `priced`. */
  cost: number;
  priced: boolean;
  notional: number;
  /** cost / notional; undefined when unpriced or notional is 0. */
  ratio: number | undefined;
}

export interface CostSummary {
  total: number;
  tokens: number;
  unpricedTokens: number;
  byModel: ModelCost[];
}

export function summarizeCost(msgs: MessageUsage[], table: PriceTable = PRICES): CostSummary {
  const by = new Map<string, ModelCost>();
  let total = 0;
  let tokens = 0;
  let unpricedTokens = 0;
  for (const m of msgs) {
    const c = computeCost(m, m.model, table);
    const t = totalTokens(m);
    const key = normalizeModelId(m.model);
    const e = by.get(key) ?? {
      model: key,
      messages: 0,
      tokens: 0,
      cost: 0,
      priced: c !== undefined,
      notional: 0,
      ratio: undefined,
    };
    e.messages++;
    e.tokens += t;
    e.notional += m.notional;
    e.cost += c ?? 0;
    by.set(key, e);
    tokens += t;
    if (c === undefined) unpricedTokens += t;
    else total += c;
  }
  const byModel = [...by.values()].map((e) => ({
    ...e,
    ratio: e.priced && e.notional > 0 ? e.cost / e.notional : undefined,
  }));
  byModel.sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
  return { total, tokens, unpricedTokens, byModel };
}

export interface SessionCost {
  cost: number;
  unpricedTokens: number;
}

/** Per-session priced cost plus the tokens that could not be priced. */
export function costBySession(
  msgs: MessageUsage[],
  table: PriceTable = PRICES,
): Map<string, SessionCost> {
  const out = new Map<string, SessionCost>();
  for (const m of msgs) {
    const e = out.get(m.file) ?? { cost: 0, unpricedTokens: 0 };
    const c = computeCost(m, m.model, table);
    if (c === undefined) e.unpricedTokens += totalTokens(m);
    else e.cost += c;
    out.set(m.file, e);
  }
  return out;
}
