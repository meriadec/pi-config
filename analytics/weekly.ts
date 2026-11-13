/** Weekly report sections. Pure: per-session facts in, short markdown sections out. No I/O, no network. */
import { detectPolling } from "../agent/extensions/wait/polling.ts";
import { computeCost, totalTokens, type MessageUsage } from "./cost.ts";
import { labelByRules, type SessionFeatures } from "./label.ts";
import { MIN_SESSIONS, buildReport, type ModelSessionInput } from "./models.ts";
import { normalizeModelId } from "./prices.ts";
import { UNLABELLED } from "./profile.ts";
import { costSplit } from "./tail.ts";

export const DAY_MS = 86_400_000;
export const PREV_WEEKS = 4;
export const MAX_SECTION_LINES = 12;
export const NEW_LABEL_CAP = 300;
export const RULES_VERSION = "rules-v1";
export const CONTEXT_K = [150, 300] as const;

export interface WeeklySession {
  file: string;
  startedMs: number;
  label: string;
  usage: MessageUsage[];
  /** Tooling failure counts by class (only TOOLING_CLASSES). */
  toolingErrors: Record<string, number>;
  bashCommands: string[];
}

export interface Windows {
  weekStart: number;
  weekEnd: number;
  prevStart: number;
}

/** Week = 7 days from `start`; previous = the 4 weeks before it. Sessions go by start time. */
export function windowsFrom(weekStart: number): Windows {
  return {
    weekStart,
    weekEnd: weekStart + 7 * DAY_MS,
    prevStart: weekStart - PREV_WEEKS * 7 * DAY_MS,
  };
}

export function split(all: WeeklySession[], w: Windows) {
  return {
    week: all.filter((s) => s.startedMs >= w.weekStart && s.startedMs < w.weekEnd),
    prev: all.filter((s) => s.startedMs >= w.prevStart && s.startedMs < w.weekStart),
  };
}

// ---- incremental labelling (no network) ----

export interface RuleLabel {
  file: string;
  label: string;
  promptVersion: string;
}

/**
 * Label sessions missing from both caches with the rules, at most `cap` per run.
 * Rules that do not match give UNLABELLED, cached so the session is not retried.
 */
export function resolveLabels(
  sessions: (SessionFeatures & { file: string })[],
  llm: ReadonlyMap<string, { label: string }>,
  ruleCache: ReadonlyMap<string, { label: string }>,
  cap = NEW_LABEL_CAP,
) {
  const labelOf = new Map<string, string>();
  const added: RuleLabel[] = [];
  let left = 0;
  for (const s of sessions) {
    const known = llm.get(s.file) ?? ruleCache.get(s.file);
    if (known) {
      labelOf.set(s.file, known.label);
    } else if (added.length < cap) {
      const label = labelByRules(s).label ?? UNLABELLED;
      added.push({ file: s.file, label, promptVersion: RULES_VERSION });
      labelOf.set(s.file, label);
    } else {
      left++;
      labelOf.set(s.file, UNLABELLED);
    }
  }
  const line =
    left > 0
      ? `Labels: ${added.length} new sessions labelled by rules; ${left} sessions left unlabelled (cap ${cap} per run). Run again to label more.`
      : `Labels: ${added.length} new sessions labelled by rules; none left unlabelled by the cap.`;
  return { labelOf, added, left, line };
}

// ---- helpers ----

const usd = (x: number) => `$${x.toFixed(2)}`;
const prevPerWeek = (n: number) => n / PREV_WEEKS;
const pctChange = (now: number, before: number) =>
  before === 0
    ? now === 0
      ? "="
      : "new"
    : `${now >= before ? "+" : ""}${Math.round((100 * (now - before)) / before)}%`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Keep the section inside the line budget. */
function section(title: string, body: string[]): string[] {
  const max = MAX_SECTION_LINES - 1;
  const lines =
    body.length > max
      ? [...body.slice(0, max - 1), `- … ${body.length - max + 1} more lines cut`]
      : body;
  return [`## ${title}`, ...lines];
}

export interface Spend {
  total: number;
  byLabel: Map<string, number>;
  unpricedByLabel: Map<string, number>;
  byModel: Map<string, number>;
  /** Tokens of models with no price. */
  unpricedByModel: Map<string, number>;
  sessionCost: Map<string, number>;
}

export function spendOf(sessions: WeeklySession[]): Spend {
  const s: Spend = {
    total: 0,
    byLabel: new Map(),
    unpricedByLabel: new Map(),
    byModel: new Map(),
    unpricedByModel: new Map(),
    sessionCost: new Map(),
  };
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const x of sessions) {
    s.sessionCost.set(x.file, 0);
    for (const u of x.usage) {
      const model = normalizeModelId(u.model);
      const c = computeCost(u, u.model);
      if (c === undefined) {
        add(s.unpricedByModel, model, totalTokens(u));
        add(s.unpricedByLabel, x.label, totalTokens(u));
      } else {
        s.total += c;
        add(s.byModel, model, c);
        add(s.byLabel, x.label, c);
        add(s.sessionCost, x.file, c);
      }
    }
    if (!s.byLabel.has(x.label)) s.byLabel.set(x.label, 0);
  }
  return s;
}

const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n);

// ---- sections ----

export function spendSection(week: Spend, prev: Spend): string[] {
  const row = (k: string, v: number, p: number | undefined, unpricedTok?: number) =>
    `- ${k}: ${usd(v)} (prev ${usd(prevPerWeek(p ?? 0))}/wk, ${pctChange(v, prevPerWeek(p ?? 0))})${unpricedTok ? ` + ${unpricedTok} unpriced tokens` : ""}`;
  const lines = [
    `Total ${usd(week.total)} (prev ${usd(prevPerWeek(prev.total))}/wk, ${pctChange(week.total, prevPerWeek(prev.total))}). By label:`,
    ...top(week.byLabel, 4).map(([k, v]) =>
      row(k, v, prev.byLabel.get(k), week.unpricedByLabel.get(k)),
    ),
    "By model:",
    ...top(week.byModel, 4).map(([k, v]) => row(k, v, prev.byModel.get(k))),
    ...top(week.unpricedByModel, 2).map(
      ([k, t]) => `- ${k}: unpriced (${t} tokens, no cost counted)`,
    ),
  ];
  return section("1. Spend at API prices", lines);
}

export function concentrationSection(
  week: Spend,
  prev: Spend,
  paths: Map<string, string>,
): string[] {
  const share = (s: Spend) => {
    const costs = [...s.sessionCost.values()].sort((a, b) => b - a);
    const k = Math.max(1, Math.ceil(0.05 * costs.length));
    const total = sum(costs);
    return { k, n: costs.length, share: total > 0 ? sum(costs.slice(0, k)) / total : 0 };
  };
  const w = share(week);
  const p = share(prev);
  if (w.n === 0) return section("2. Cost concentration", ["- no sessions this week"]);
  return section("2. Cost concentration", [
    `- Top 5% (${w.k} of ${w.n} sessions) hold ${(100 * w.share).toFixed(0)}% of cost (prev 4 weeks: ${(100 * p.share).toFixed(0)}%)`,
    "- Top 3 sessions:",
    ...top(week.sessionCost, 3).map(([f, c]) => `  - ${usd(c)} ${paths.get(f) ?? f}`),
  ]);
}

export const peakPrompt = (s: WeeklySession) =>
  Math.max(0, ...s.usage.map((m) => m.input + m.cacheRead + m.cacheWrite));

/** Cost of the cache-read tokens above `k` thousand prompt tokens, summed over messages. */
export function cacheReadAbove(sessions: WeeklySession[], k: number): number {
  const cap = k * 1e3;
  let usdTotal = 0;
  for (const s of sessions)
    for (const m of s.usage) {
      const p = m.input + m.cacheRead + m.cacheWrite;
      if (p > cap)
        usdTotal +=
          costSplit([m]).cacheRead * (Math.min(m.cacheRead, p - cap) / (m.cacheRead || 1));
    }
  return usdTotal;
}

export function contextSection(week: WeeklySession[], prev: WeeklySession[]): string[] {
  const count = (xs: WeeklySession[], k: number) =>
    xs.filter((s) => peakPrompt(s) > k * 1e3).length;
  const lines = CONTEXT_K.map(
    (k) =>
      `- Sessions above ${k}K: ${count(week, k)} of ${week.length} (prev ${prevPerWeek(count(prev, k)).toFixed(1)}/wk)`,
  );
  const c = cacheReadAbove(week, CONTEXT_K[0]);
  lines.push(
    `- Est. cost of cache reads above ${CONTEXT_K[0]}K: ${usd(c)} (prev ${usd(prevPerWeek(cacheReadAbove(prev, CONTEXT_K[0])))}/wk)`,
  );
  return section("3. Peak context", lines);
}

export function errorTotals(sessions: WeeklySession[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sessions)
    for (const [c, n] of Object.entries(s.toolingErrors)) m.set(c, (m.get(c) ?? 0) + n);
  return m;
}

export function errorsSection(week: WeeklySession[], prev: WeeklySession[]): string[] {
  const w = errorTotals(week);
  const p = errorTotals(prev);
  const rows = top(w, 5).map(
    ([c, n]) =>
      `- ${c}: ${n} (prev ${prevPerWeek(p.get(c) ?? 0).toFixed(1)}/wk, ${pctChange(n, prevPerWeek(p.get(c) ?? 0))})`,
  );
  return section("4. Tooling errors (top 5 classes)", rows.length ? rows : ["- none"]);
}

export function pollingTotals(sessions: WeeklySession[]): {
  kinds: Map<string, number>;
  sessions: number;
} {
  const kinds = new Map<string, number>();
  let n = 0;
  for (const s of sessions) {
    let hit = false;
    for (const c of s.bashCommands) {
      const k = detectPolling(c);
      if (!k) continue;
      kinds.set(k, (kinds.get(k) ?? 0) + 1);
      hit = true;
    }
    if (hit) n++;
  }
  return { kinds, sessions: n };
}

export function pollingSection(week: WeeklySession[], prev: WeeklySession[]): string[] {
  const w = pollingTotals(week);
  const p = pollingTotals(prev);
  const total = sum([...w.kinds.values()]);
  const lines = [
    `- Sleep commands and shell loops: ${total} in ${w.sessions} sessions (prev ${prevPerWeek(sum([...p.kinds.values()])).toFixed(1)}/wk)`,
    ...top(w.kinds, 5).map(([k, n]) => `  - ${k}: ${n}`),
  ];
  return section("5. Polling", lines);
}

export function modelsSection(inputs: ModelSessionInput[]): string[] {
  const r = buildReport(inputs);
  const sessionsBy = new Map<string, number>();
  for (const i of inputs) sessionsBy.set(i.label, (sessionsBy.get(i.label) ?? 0) + 1);
  const lines = top(sessionsBy, 6).map(([label, n]) => {
    const cells = r.cells.filter((c) => c.label === label);
    if (cells.length === 0)
      return `- ${label}: too few (${n} sessions, need ${MIN_SESSIONS} per model)`;
    return `- ${label}: ${cells.map((c) => `${c.model} ${c.sessions} sessions, median ${c.medCost === null ? "unpriced" : usd(c.medCost)}`).join("; ")}`;
  });
  return section(
    "6. Model use by label (human sessions, cells of 15+)",
    lines.length ? lines : ["- too few"],
  );
}

export interface Mover {
  name: string;
  week: number;
  prev: number;
  unit: "$" | "n";
}

export function movers(w: Spend, p: Spend, week: WeeklySession[], prev: WeeklySession[]): Mover[] {
  const out: Mover[] = [
    { name: "total spend", week: w.total, prev: prevPerWeek(p.total), unit: "$" },
  ];
  for (const [k, v] of w.byLabel)
    out.push({ name: `spend ${k}`, week: v, prev: prevPerWeek(p.byLabel.get(k) ?? 0), unit: "$" });
  for (const [k, v] of w.byModel)
    out.push({ name: `spend ${k}`, week: v, prev: prevPerWeek(p.byModel.get(k) ?? 0), unit: "$" });
  out.push({ name: "sessions", week: week.length, prev: prevPerWeek(prev.length), unit: "n" });
  const we = errorTotals(week);
  const pe = errorTotals(prev);
  for (const [k, v] of we)
    out.push({
      name: `tooling errors ${k}`,
      week: v,
      prev: prevPerWeek(pe.get(k) ?? 0),
      unit: "n",
    });
  out.push({
    name: "polling commands",
    week: sum([...pollingTotals(week).kinds.values()]),
    prev: prevPerWeek(sum([...pollingTotals(prev).kinds.values()])),
    unit: "n",
  });
  const big = (xs: WeeklySession[]) => xs.filter((s) => peakPrompt(s) > 150e3).length;
  out.push({
    name: "sessions above 150K",
    week: big(week),
    prev: prevPerWeek(big(prev)),
    unit: "n",
  });
  const floor = 5;
  return out
    .filter((m) => Math.max(m.week, m.prev) >= floor)
    .sort(
      (a, b) =>
        Math.abs(b.week - b.prev) / Math.max(b.week, b.prev) -
          Math.abs(a.week - a.prev) / Math.max(a.week, a.prev) ||
        Math.abs(b.week - b.prev) - Math.abs(a.week - a.prev),
    )
    .slice(0, 3);
}

const fmt = (m: Mover, v: number) => (m.unit === "$" ? usd(v) : v.toFixed(1));
export const moverLine = (m: Mover) =>
  `${m.name}: ${fmt(m, m.week)} vs ${fmt(m, m.prev)}/wk (${pctChange(m.week, m.prev)})`;

export function changedSection(ms: Mover[]): string[] {
  return section(
    "7. What changed",
    ms.length ? ms.map((m) => `- ${moverLine(m)}`) : ["- no mover above the floor"],
  );
}

export function renderWeekly(args: {
  date: string;
  windows: Windows;
  sessions: WeeklySession[];
  paths: Map<string, string>;
  modelInputs: ModelSessionInput[];
  labelLine: string;
}): string {
  const { week, prev } = split(args.sessions, args.windows);
  const w = spendOf(week);
  const p = spendOf(prev);
  const ms = movers(w, p, week, prev);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return [
    `# Pi weekly report ${args.date}`,
    `Week ${day(args.windows.weekStart)}..${day(args.windows.weekEnd - 1)}: ${usd(w.total)}, ${week.length} sessions, biggest mover: ${ms[0] ? moverLine(ms[0]) : "none"}`,
    `Compared with the previous ${PREV_WEEKS} weeks (shown per week). ${args.labelLine}`,
    "",
    ...[
      spendSection(w, p),
      concentrationSection(w, p, args.paths),
      contextSection(week, prev),
      errorsSection(week, prev),
      pollingSection(week, prev),
      modelsSection(args.modelInputs),
      changedSection(ms),
    ].flatMap((s) => [...s, ""]),
  ].join("\n");
}
