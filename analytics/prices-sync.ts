#!/usr/bin/env bun
/** Regenerate prices.catalog.json from the pi-ai model catalog in node_modules. Run after upgrading pi-ai. */
import { writeFileSync } from "node:fs";
import { normalizeModelId, type Price } from "./prices.ts";

/** First provider with a price wins: first-party APIs first, then resellers that carry the same ids. */
const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "deepseek",
  "google",
  "xai",
  "mistral",
  "github-copilot",
  "openrouter",
];

const dist = new URL("../node_modules/@earendil-works/pi-ai/", import.meta.url);
const version = (await Bun.file(new URL("package.json", dist)).json()).version as string;
const { MODELS } = (await import(new URL("dist/models.generated.js", dist).href)) as {
  MODELS: Record<string, Record<string, { id: string; cost?: Price }>>;
};

const out: Record<string, Price> = {};
for (const provider of PROVIDER_ORDER) {
  for (const m of Object.values(MODELS[provider] ?? {})) {
    if (m.id.includes(":") || m.id.startsWith("~") || !m.cost) continue; // batch / alias variants
    const { input, output, cacheRead, cacheWrite, tiers } = m.cost;
    if (!(input > 0 || output > 0)) continue; // 0/0 means "unknown or routed", never "free"
    const key = normalizeModelId(m.id);
    if (out[key]) continue;
    out[key] = {
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(tiers ? { tiers } : {}),
      source: `@earendil-works/pi-ai@${version} models.generated: ${provider}/${m.id}`,
    };
  }
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(
  new URL("./prices.catalog.json", import.meta.url),
  JSON.stringify(
    { version: `pi-ai@${version}`, unit: "USD per 1M tokens", models: sorted },
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${Object.keys(sorted).length} prices from pi-ai@${version}`);
