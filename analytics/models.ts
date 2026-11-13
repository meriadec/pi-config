/** Model comparison per task label. Pure: per-session facts in, tables and verdicts out. */
import { computeCost, type MessageUsage } from "./cost.ts";
import { median, percentile } from "./profile.ts";
import { normalizeModelId } from "./prices.ts";

export const MIN_SESSIONS = 15;
/** Matched cells need this many sessions on each side. Lower than MIN_SESSIONS on purpose: cells are small. */
export const MIN_CELL = 3;
export const IDLE_GAP_MS = 5 * 60_000;
export const UNPRICED = "unpriced";

export interface ModelSessionInput {
  file: string;
  label: string;
  /** Assistant messages with usage, in order. */
  usage: MessageUsage[];
  /** Message timestamps in ms. */
  timestamps: number[];
  toolResults: number;
  toolErrors: number;
  aborts: number;
  /** Assistant messages with stopReason 'error'. */
  stopErrors: number;
  userMessages: number;
  /** Texts of the last user messages, excluding the first (the task). At most 3 are used. */
  lastUsers: string[];
}

export interface ModelSession {
  file: string;
  label: string;
  /** Model with most assistant turns. Ties: more cost first is not used; alphabetical, to stay stable. */
  model: string;
  models: string[];
  switched: boolean;
  month: string;
  band: string;
  turns: number;
  /** Recomputed USD. null when any turn has an unpriced model: never zero. */
  cost: number | null;
  toolResults: number;
  toolErrors: number;
  aborted: boolean;
  stopErrors: number;
  userMessages: number;
  wallMin: number;
  activeMin: number;
  outputTokens: number;
  correction: { snippet: string } | null;
}

/** Strong words anywhere, or a message that opens with a bare no/non (not "no need", "no question"). */
export const CORRECTION_RE =
  /\b(wrong|revert|undo|incorrect|rollback|roll back|not what i|that'?s not|doesn'?t work|still (broken|failing|fails)|annule)\b|^\s*(no|nope|non)\b(?!\s+(need|problem|question|worries|more|other|further))/i;

/** First keyword match in the last 3 user messages, as an 80-char snippet around the match. */
export function findCorrection(lastUsers: string[]): { snippet: string } | null {
  for (const t of lastUsers.slice(-3).reverse()) {
    const m = CORRECTION_RE.exec(t);
    if (!m) continue;
    const start = Math.max(0, m.index - 30);
    return { snippet: t.slice(start, start + 80).replace(/\s+/g, " ") };
  }
  return null;
}

export const monthOf = (ms: number) => new Date(ms).toISOString().slice(0, 7);

/** Turn bands for matching: sessions of very different length are not comparable. */
export function turnBand(turns: number): string {
  return turns <= 10 ? "01-10" : turns <= 30 ? "11-30" : turns <= 80 ? "31-80" : "81+";
}

/** Most frequent model (normalized). Ties break alphabetically. */
export function dominantModel(models: string[]): string {
  const n = new Map<string, number>();
  for (const m of models) n.set(m, (n.get(m) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? "unknown";
}

export function toSession(s: ModelSessionInput): ModelSession {
  const models = s.usage.map((u) => normalizeModelId(u.model));
  const distinct = [...new Set(models)].sort();
  const costs = s.usage.map((u) => computeCost(u, u.model));
  const ts = s.timestamps;
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
  return {
    file: s.file,
    label: s.label,
    model: dominantModel(models),
    models: distinct,
    switched: distinct.length > 1,
    month: ts.length ? monthOf(ts[0]!) : "unknown",
    band: turnBand(s.usage.length),
    turns: s.usage.length,
    cost: costs.some((c) => c === undefined) ? null : costs.reduce<number>((a, c) => a + c!, 0),
    toolResults: s.toolResults,
    toolErrors: s.toolErrors,
    aborted: s.aborts > 0,
    stopErrors: s.stopErrors,
    userMessages: s.userMessages,
    wallMin: ts.length > 1 ? (ts.at(-1)! - ts[0]!) / 60_000 : 0,
    activeMin: gaps.filter((g) => g <= IDLE_GAP_MS).reduce((a, b) => a + b, 0) / 60_000,
    outputTokens: s.usage.reduce((a, u) => a + (u.output ?? 0), 0),
    correction: findCorrection(s.lastUsers),
  };
}

export interface CellStats {
  label: string;
  model: string;
  sessions: number;
  unpriced: number;
  medTurns: number;
  /** null when no session is priced. */
  medCost: number | null;
  p90Cost: number | null;
  costPerTurn: number | null;
  toolErrPct: number;
  abortPct: number;
  stopErrPer100Turns: number;
  usersPerSession: number;
  /** Keyword proxy: share of sessions whose last 3 user messages match CORRECTION_RE. */
  correctionPct: number;
  medWallMin: number;
  medActiveMin: number;
  medOutputTok: number;
}

const pct = (a: number, b: number) => (b ? (100 * a) / b : 0);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function cellStats(label: string, model: string, xs: ModelSession[]): CellStats {
  const priced = xs.filter((s) => s.cost !== null);
  const costs = priced.map((s) => s.cost!);
  const turns = sum(xs.map((s) => s.turns));
  const pricedTurns = sum(priced.map((s) => s.turns));
  return {
    label,
    model,
    sessions: xs.length,
    unpriced: xs.length - priced.length,
    medTurns: median(xs.map((s) => s.turns)),
    medCost: costs.length ? median(costs) : null,
    p90Cost: costs.length ? percentile(costs, 90) : null,
    costPerTurn: pricedTurns ? sum(costs) / pricedTurns : null,
    toolErrPct: pct(sum(xs.map((s) => s.toolErrors)), sum(xs.map((s) => s.toolResults))),
    abortPct: pct(xs.filter((s) => s.aborted).length, xs.length),
    stopErrPer100Turns: pct(sum(xs.map((s) => s.stopErrors)), turns),
    usersPerSession: sum(xs.map((s) => s.userMessages)) / xs.length,
    correctionPct: pct(xs.filter((s) => s.correction).length, xs.length),
    medWallMin: median(xs.map((s) => s.wallMin)),
    medActiveMin: median(xs.map((s) => s.activeMin)),
    medOutputTok: median(xs.map((s) => s.outputTokens)),
  };
}

export interface Matched {
  a: string;
  b: string;
  cells: number;
  /** Sessions counted: sum of min(nA, nB) over cells. */
  weight: number;
  /** Weighted mean over cells of median cost a / median cost b. null when no priced cell. */
  costRatio: number | null;
  activeMinRatio: number | null;
  /** Weighted mean differences a - b. */
  usersDiff: number;
  abortPctDiff: number;
  correctionPctDiff: number;
  stopErrPer100Diff: number;
}

/** Compare models a and b only inside cells with the same label x month x turn band. */
export function matched(sessions: ModelSession[], a: string, b: string): Matched {
  const cells = new Map<string, { a: ModelSession[]; b: ModelSession[] }>();
  for (const s of sessions) {
    if (s.switched || (s.model !== a && s.model !== b)) continue;
    const k = `${s.label}|${s.month}|${s.band}`;
    const c = cells.get(k) ?? { a: [], b: [] };
    (s.model === a ? c.a : c.b).push(s);
    cells.set(k, c);
  }
  let weight = 0;
  let n = 0;
  let wCost = 0;
  let wCostW = 0;
  let wTime = 0;
  let wTimeW = 0;
  const d = { users: 0, abort: 0, corr: 0, stop: 0 };
  for (const c of cells.values()) {
    if (c.a.length < MIN_CELL || c.b.length < MIN_CELL) continue;
    const w = Math.min(c.a.length, c.b.length);
    const sa = cellStats("", a, c.a);
    const sb = cellStats("", b, c.b);
    n++;
    weight += w;
    if (sa.medCost !== null && sb.medCost !== null && sb.medCost > 0) {
      wCost += (w * sa.medCost) / sb.medCost;
      wCostW += w;
    }
    if (sb.medActiveMin > 0) {
      wTime += (w * sa.medActiveMin) / sb.medActiveMin;
      wTimeW += w;
    }
    d.users += w * (sa.usersPerSession - sb.usersPerSession);
    d.abort += w * (sa.abortPct - sb.abortPct);
    d.corr += w * (sa.correctionPct - sb.correctionPct);
    d.stop += w * (sa.stopErrPer100Turns - sb.stopErrPer100Turns);
  }
  const per = (x: number) => (weight ? x / weight : 0);
  return {
    a,
    b,
    cells: n,
    weight,
    costRatio: wCostW ? wCost / wCostW : null,
    activeMinRatio: wTimeW ? wTime / wTimeW : null,
    usersDiff: per(d.users),
    abortPctDiff: per(d.abort),
    correctionPctDiff: per(d.corr),
    stopErrPer100Diff: per(d.stop),
  };
}

export interface Verdict {
  label: string;
  spend: number;
  costly: string;
  cheap: string | null;
  claim: boolean;
  reason: string;
  matched: Matched | null;
  /** USD, matched ratio applied to all costly-model spend in the label. 0 when no claim. */
  savedAll: number;
  /** USD, only on the matched sessions of the costly model. */
  savedMatched: number;
}

export interface Report {
  labels: string[];
  cells: CellStats[];
  switched: { label: string; sessions: number; of: number }[];
  monthShare: { month: string; total: number; share: Record<string, number> }[];
  spend: { label: string; usd: number; unpricedSessions: number }[];
  verdicts: Verdict[];
  keywordCheck: { fired: number; of: number };
}

/** Claim needs: cheaper in matched cells, at least 20 matched sessions, and no worse proxies. */
export const MIN_MATCHED = 20;

export function verdictFor(
  label: string,
  sessions: ModelSession[],
  eligible: string[],
  spend: number,
): Verdict {
  const mine = sessions.filter((s) => s.label === label && !s.switched);
  const costOf = (m: string) =>
    mine.filter((s) => s.model === m).reduce((a, s) => a + (s.cost ?? 0), 0);
  const base = { label, spend, savedAll: 0, savedMatched: 0, matched: null as Matched | null };
  const priced = eligible.filter((m) => mine.some((s) => s.model === m && s.cost !== null));
  if (priced.length < 2)
    return {
      ...base,
      costly: priced[0] ?? "-",
      cheap: null,
      claim: false,
      reason: "no evidence: fewer than 2 priced models with 15+ sessions",
    };
  const costly = [...priced].sort((x, y) => costOf(y) - costOf(x))[0]!;
  let best: Matched | null = null;
  for (const m of priced) {
    if (m === costly) continue;
    const r = matched(mine, m, costly); // ratio = m / costly
    if (r.weight < MIN_MATCHED || r.costRatio === null) continue;
    if (!best || r.costRatio < best.costRatio!) best = r;
  }
  if (!best)
    return {
      ...base,
      costly,
      cheap: null,
      claim: false,
      reason: `no evidence: under ${MIN_MATCHED} matched sessions vs ${costly}`,
    };
  const worse =
    best.abortPctDiff > 2 ||
    best.stopErrPer100Diff > 0.5 ||
    best.correctionPctDiff > 5 ||
    best.usersDiff > 0.5;
  const cheaper = best.costRatio! < 0.9;
  const claim = cheaper && !worse;
  const reason = !cheaper
    ? `no evidence: ${best.b}/${best.a} matched cost ratio ${best.costRatio!.toFixed(2)} is not below 0.90`
    : worse
      ? `no evidence: ${best.a} is cheaper (x${best.costRatio!.toFixed(2)}) but a proxy is worse`
      : `${best.a} costs x${best.costRatio!.toFixed(2)} of ${costly} on ${best.weight} matched sessions with no worse proxies`;
  const costlyAll = mine.filter((s) => s.model === costly && s.cost !== null);
  const savedAll = claim ? costOf(costly) * (1 - best.costRatio!) : 0;
  // matched sessions only: cells where both models have MIN_CELL+
  const keys = new Set(mine.filter((s) => s.model === best!.a).map((s) => `${s.month}|${s.band}`));
  const cellCount = new Map<string, number>();
  for (const s of mine.filter((x) => x.model === best!.a))
    cellCount.set(`${s.month}|${s.band}`, (cellCount.get(`${s.month}|${s.band}`) ?? 0) + 1);
  const inMatched = costlyAll.filter((s) => {
    const k = `${s.month}|${s.band}`;
    return (
      keys.has(k) &&
      (cellCount.get(k) ?? 0) >= MIN_CELL &&
      costlyAll.filter((x) => `${x.month}|${x.band}` === k).length >= MIN_CELL
    );
  });
  const savedMatched = claim ? sum(inMatched.map((s) => s.cost!)) * (1 - best.costRatio!) : 0;
  return { ...base, costly, cheap: best.a, claim, reason, matched: best, savedAll, savedMatched };
}

export function buildReport(inputs: ModelSessionInput[], opts: { label?: string } = {}): Report {
  const all = inputs.map(toSession);
  const sessions = opts.label ? all.filter((s) => s.label === opts.label) : all;
  const main = sessions.filter((s) => !s.switched);
  const labels = [...new Set(main.map((s) => s.label))].sort();
  const cells: CellStats[] = [];
  const eligibleBy = new Map<string, string[]>();
  for (const l of labels) {
    const by = new Map<string, ModelSession[]>();
    for (const s of main.filter((x) => x.label === l))
      by.set(s.model, [...(by.get(s.model) ?? []), s]);
    for (const [m, xs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
      if (xs.length < MIN_SESSIONS) continue;
      cells.push(cellStats(l, m, xs));
      eligibleBy.set(l, [...(eligibleBy.get(l) ?? []), m]);
    }
  }
  const switchedBy = labels.map((l) => {
    const xs = sessions.filter((s) => s.label === l);
    return { label: l, sessions: xs.filter((s) => s.switched).length, of: xs.length };
  });
  const months = [...new Set(main.map((s) => s.month))].sort();
  const monthShare = months.map((month) => {
    const xs = main.filter((s) => s.month === month);
    const share: Record<string, number> = {};
    for (const s of xs) share[s.model] = (share[s.model] ?? 0) + 1 / xs.length;
    return { month, total: xs.length, share };
  });
  const spend = labels
    .map((label) => {
      const xs = sessions.filter((s) => s.label === label);
      return {
        label,
        usd: sum(xs.map((s) => s.cost ?? 0)),
        unpricedSessions: xs.filter((s) => s.cost === null).length,
      };
    })
    .sort((a, b) => b.usd - a.usd);
  const verdicts = spend
    .slice(0, 5)
    .map((s) => verdictFor(s.label, main, eligibleBy.get(s.label) ?? [], s.usd));
  return {
    labels,
    cells,
    switched: switchedBy,
    monthShare,
    spend,
    verdicts,
    keywordCheck: { fired: sessions.filter((s) => s.correction).length, of: sessions.length },
  };
}

/** Evenly spread sample of sessions the keyword proxy fired on, for a hand check. */
export function keywordSample(
  inputs: ModelSessionInput[],
  n = 15,
): { file: string; snippet: string }[] {
  const hits = inputs.map(toSession).filter((s) => s.correction);
  const step = Math.max(1, Math.ceil(hits.length / n));
  return hits
    .filter((_, i) => i % step === 0)
    .slice(0, n)
    .map((s) => ({ file: s.file, snippet: s.correction!.snippet }));
}

const f = (x: number | null, d = 2) => (x === null ? UNPRICED : x.toFixed(d));

export function formatReport(r: Report): string {
  const out: string[] = [];
  out.push(
    `Models per label (human sessions, no model switch, >=${MIN_SESSIONS} sessions per cell)`,
  );
  out.push(
    "Proxies (weak): user msgs/session, abort %, stop-error per 100 turns, keyword % (last 3 user msgs say no/wrong/revert/undo...).",
  );
  out.push(
    "Cost = recomputed USD; a session with any unpriced turn is counted in 'unp', not in cost.\n",
  );
  for (const l of r.labels) {
    const cs = r.cells.filter((c) => c.label === l);
    const sw = r.switched.find((s) => s.label === l)!;
    out.push(`## ${l}  (switched model, excluded: ${sw.sessions} of ${sw.of})`);
    if (!cs.length) {
      out.push("  no model has enough sessions\n");
      continue;
    }
    out.push(
      "model                    n unp  turns   med$   p90$  $/turn  err% abort% stop/100t  usr  kw%  wallM  actM  outK",
    );
    for (const c of cs)
      out.push(
        `${c.model.padEnd(22)} ${String(c.sessions).padStart(4)} ${String(c.unpriced).padStart(3)} ${c.medTurns.toFixed(0).padStart(6)} ${f(c.medCost).padStart(6)} ${f(c.p90Cost).padStart(6)} ${f(c.costPerTurn, 3).padStart(7)} ${c.toolErrPct.toFixed(1).padStart(5)} ${c.abortPct.toFixed(1).padStart(6)} ${c.stopErrPer100Turns.toFixed(2).padStart(9)} ${c.usersPerSession.toFixed(1).padStart(4)} ${c.correctionPct.toFixed(0).padStart(4)} ${c.medWallMin.toFixed(1).padStart(6)} ${c.medActiveMin.toFixed(1).padStart(5)} ${(c.medOutputTok / 1000).toFixed(1).padStart(5)}`,
      );
    out.push("");
  }
  out.push("## Model share by month (sessions, no switch)");
  const ms = [...new Set(r.monthShare.flatMap((m) => Object.keys(m.share)))].sort();
  for (const m of r.monthShare)
    out.push(
      `${m.month} n=${String(m.total).padStart(4)} ` +
        ms
          .filter((k) => m.share[k])
          .sort((a, b) => m.share[b]! - m.share[a]!)
          .map((k) => `${k} ${(100 * m.share[k]!).toFixed(0)}%`)
          .join(", "),
    );
  out.push(`\nKeyword proxy fired on ${r.keywordCheck.fired} of ${r.keywordCheck.of} sessions.`);
  out.push("\n## Matched comparison and verdicts (5 biggest-spend labels)");
  out.push(
    "Matched = same label x month x turn band, >=3 sessions per model per cell, weight = min(nA,nB).",
  );
  for (const v of r.verdicts) {
    out.push(
      `- ${v.label} (spend $${v.spend.toFixed(0)}, costliest model ${v.costly}): ${v.reason}`,
    );
    if (v.matched) {
      const m = v.matched;
      out.push(
        `    vs ${m.a}: ${m.cells} cells, ${m.weight} sessions, cost x${f(m.costRatio)}, active time x${f(m.activeMinRatio)}, usr/session ${m.usersDiff >= 0 ? "+" : ""}${m.usersDiff.toFixed(2)}, abort ${m.abortPctDiff.toFixed(1)}pp, kw ${m.correctionPctDiff.toFixed(1)}pp, stop/100t ${m.stopErrPer100Diff.toFixed(2)}`,
      );
    }
    out.push(
      v.claim
        ? `    cheaper model could probably do it: saves ~$${v.savedAll.toFixed(0)} (all ${v.costly} sessions) / ~$${v.savedMatched.toFixed(0)} (matched sessions only)`
        : "    no evidence",
    );
  }
  out.push(
    "\nLimits: model choice, project and task difficulty are tangled. Users pick the costly model for hard tasks, and models ran in different months. Month x turn band matching removes period and size effects only. It cannot remove difficulty the turn count does not show. Savings assume the matched cost ratio holds for all sessions of the costly model, and that the cheap model needs the same user effort (proxies are weak).",
  );
  return out.join("\n");
}
