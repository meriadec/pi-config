import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type NudgeMode = "off" | "shadow" | "notify";

export const STEP_TOKENS = 100_000;
export const DEFAULT_THRESHOLD = 150_000;

export const LOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../analytics/data/context-nudge.jsonl",
);

export function parseMode(v: string | undefined): NudgeMode {
  const x = v?.trim().toLowerCase();
  return x === "off" || x === "notify" ? x : "shadow";
}

export function parseThreshold(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

/** -1 below threshold; 0 from threshold; +1 for each further 100K. */
export function bandOf(tokens: number, threshold: number): number {
  return tokens < threshold ? -1 : Math.floor((tokens - threshold) / STEP_TOKENS);
}

/** Append one JSON line. Never throws. */
export function appendLine(path: string, record: Record<string, unknown>): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readLines(path: string): Record<string, unknown>[] {
  try {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
