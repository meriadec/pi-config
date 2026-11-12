import { readFileSync } from "node:fs";
import { LOG_PATH } from "../agent/extensions/context-guard/log.ts";

interface GuardRecord {
  rule?: string;
  family?: string;
  cmdSha1?: string;
  removed?: number;
}

export interface GuardSummary {
  perRule: Record<string, number>;
  wouldRemoveMB: number;
  topFamilies: { family: string; removedBytes: number; caps: number }[];
  refetch: { family: string; caps: number; refetches: number; rate: number }[];
}

export function summarizeGuard(jsonl: string): GuardSummary {
  const records: GuardRecord[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as GuardRecord);
    } catch {}
  }
  const perRule: Record<string, number> = {};
  const fam = new Map<string, { removed: number; caps: number; hashes: Set<string>; re: number }>();
  const get = (f: string) => {
    let e = fam.get(f);
    if (!e) fam.set(f, (e = { removed: 0, caps: 0, hashes: new Set(), re: 0 }));
    return e;
  };
  let removed = 0;
  const capHashes = new Map<string, string>();
  for (const r of records) {
    const rule = r.rule ?? "unknown";
    perRule[rule] = (perRule[rule] ?? 0) + 1;
    if (rule === "cap") {
      const e = get(r.family ?? "?");
      e.removed += r.removed ?? 0;
      e.caps++;
      removed += r.removed ?? 0;
      if (r.cmdSha1) {
        e.hashes.add(r.cmdSha1);
        capHashes.set(r.cmdSha1, r.family ?? "?");
      }
    }
  }
  for (const r of records) {
    if (r.rule !== "refetch" || !r.cmdSha1) continue;
    const family = capHashes.get(r.cmdSha1);
    if (family !== undefined) get(family).re++;
  }
  const entries = [...fam.entries()].filter(([, e]) => e.caps > 0);
  return {
    perRule,
    wouldRemoveMB: removed / 1_000_000,
    topFamilies: entries
      .map(([family, e]) => ({ family, removedBytes: e.removed, caps: e.caps }))
      .sort((a, b) => b.removedBytes - a.removedBytes)
      .slice(0, 10),
    refetch: entries
      .map(([family, e]) => ({
        family,
        caps: e.caps,
        refetches: e.re,
        rate: e.re / e.caps,
      }))
      .sort((a, b) => b.rate - a.rate),
  };
}

export function formatGuardReport(s: GuardSummary): string {
  const lines = ["Records per rule:"];
  for (const [rule, n] of Object.entries(s.perRule)) lines.push(`  ${rule}: ${n}`);
  lines.push(
    `Would remove: ${s.wouldRemoveMB.toFixed(2)} MB`,
    "",
    "Top families by removed bytes:",
  );
  for (const f of s.topFamilies)
    lines.push(`  ${f.family}: ${f.removedBytes} bytes (${f.caps} results)`);
  lines.push("", "Re-fetch rate per family:");
  for (const f of s.refetch)
    lines.push(`  ${f.family}: ${(f.rate * 100).toFixed(1)}% (${f.refetches}/${f.caps})`);
  return lines.join("\n");
}

if (import.meta.main) {
  let text = "";
  try {
    text = readFileSync(LOG_PATH, "utf8");
  } catch {
    console.log(`No log file at ${LOG_PATH}`);
    process.exit(0);
  }
  console.log(formatGuardReport(summarizeGuard(text)));
}
