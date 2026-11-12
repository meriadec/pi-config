/** Public API price table (USD per 1M tokens). Unknown models are `undefined`, never zero. */
import catalog from "./prices.catalog.json";
import override from "./prices.override.json";

export interface PriceTier {
  /** Applies when the prompt (input + cacheRead + cacheWrite) has more tokens than this. */
  inputTokensAbove: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: PriceTier[];
  /** Where the number came from. */
  source?: string;
}

export type PriceTable = Record<string, Price>;

/** Catalog first, manual overrides on top. */
export const PRICES: PriceTable = {
  ...(catalog.models as PriceTable),
  ...(override.models as PriceTable),
};
export const PRICE_TABLE_VERSION: string = catalog.version;

/**
 * Canonical key: lowercase, strip provider prefixes ("anthropic/", "openrouter/anthropic/"),
 * strip date suffixes (-20250929, -2025-09-29), and make dots dashes ("opus-4.8" = "opus-4-8").
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  id = id.slice(id.lastIndexOf("/") + 1);
  id = id.replace(/-(\d{4}-\d{2}-\d{2}|\d{8})$/, "");
  return id.replaceAll(".", "-");
}

export function priceFor(
  model: string | undefined | null,
  table: PriceTable = PRICES,
): Price | undefined {
  if (!model) return undefined;
  return table[normalizeModelId(model)];
}
