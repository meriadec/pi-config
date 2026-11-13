/** Summary and savings replay of the context-nudge shadow log. Pure except `loadNudgeLog`. */
import { readFileSync, existsSync } from "node:fs";

export interface NudgeLine {
  ts: string;
  session: string;
  tokens: number;
  turns: number;
  cost: number | null;
}

export const NUDGE_LOG = new URL("./data/context-nudge.jsonl", import.meta.url).pathname;
export const THRESHOLDS_K = [100, 150, 200, 300];
/** From `tail`: cache reads are 61% of the cost of expensive implement sessions. */
export const CACHE_READ_SHARE = 0.61;
/** Assumed USD per 1M tokens for one cold cache write of the compacted prefix. */
export const COLD_WRITE_USD_PER_M = 3.75;

export function loadNudgeLog(path = NUDGE_LOG): NudgeLine[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        const x = JSON.parse(l);
        return typeof x.session === "string" && typeof x.tokens === "number"
          ? [x as NudgeLine]
          : [];
      } catch {
        return [];
      }
    });
}

function bySession(lines: NudgeLine[]): Map<string, NudgeLine[]> {
  const m = new Map<string, NudgeLine[]>();
  for (const l of lines) m.set(l.session, [...(m.get(l.session) ?? []), l]);
  for (const v of m.values()) v.sort((a, b) => a.turns - b.turns);
  return m;
}

export interface ReplayRow {
  thresholdK: number;
  sessions: number;
  savingUsd: number;
}

/**
 * Per session, each logged point closes a segment from the previous point (or zero).
 * Segment cost = delta cost so far. Average context = mean of segment end tokens.
 * Saved = segment cost * cache-read share * (avg - cap) / avg, when avg is above the cap.
 * One cold rewrite of `cap` tokens per session that crosses.
 */
export function replay(lines: NudgeLine[], thresholdsK = THRESHOLDS_K): ReplayRow[] {
  const sessions = bySession(lines);
  return thresholdsK.map((k) => {
    const cap = k * 1e3;
    let saving = 0;
    let n = 0;
    for (const pts of sessions.values()) {
      let prev = { tokens: 0, cost: 0 };
      let crossed = false;
      for (const p of pts) {
        const cost = p.cost ?? prev.cost;
        const avg = (prev.tokens + p.tokens) / 2;
        if (avg > cap) {
          crossed = true;
          saving += (cost - prev.cost) * CACHE_READ_SHARE * ((avg - cap) / avg);
        } else if (p.tokens > cap) {
          crossed = true;
        }
        prev = { tokens: p.tokens, cost };
      }
      if (crossed) {
        n++;
        saving -= (cap / 1e6) * COLD_WRITE_USD_PER_M;
      }
    }
    return { thresholdK: k, sessions: n, savingUsd: saving };
  });
}

export function formatNudge(lines: NudgeLine[]): string {
  if (lines.length === 0)
    return "context-nudge log is empty. Use Pi with the extension in shadow mode first.";
  const sessions = bySession(lines);
  const first = [...sessions.values()].map((v) => v[0]!);
  const ts = lines.map((l) => l.ts).sort();
  const usd = (x: number) => `$${x.toFixed(2)}`;
  return [
    `shadow log: ${lines.length} lines, ${sessions.size} sessions crossed, ${ts[0]} .. ${ts.at(-1)}`,
    `median tokens at first crossing: ${Math.round([...first].map((l) => l.tokens).sort((a, b) => a - b)[Math.floor(first.length / 2)]! / 1000)}K`,
    "",
    "replay: estimated savings if compacted or restarted at the threshold",
    "threshold  sessions  saving",
    ...replay(lines).map(
      (r) =>
        `${String(r.thresholdK + "K").padEnd(10)} ${String(r.sessions).padEnd(9)} ${usd(r.savingUsd)}`,
    ),
    "",
    "assumptions:",
    "- the log holds only crossing points (not every turn); cost between points is spread by average context",
    `- saved = segment cost x ${CACHE_READ_SHARE} (cache-read share, from tail) x share of context above the cap`,
    `- one cold rewrite of the compacted prefix per crossing session, at $${COLD_WRITE_USD_PER_M}/M tokens`,
    "- summary quality loss ignored; lines without cost add no saving; estimate, not measured",
  ].join("\n");
}
