/** Do image-heavy sessions suffer more? Pure: session JSONL lines in, grouped outcome rates out. */

export interface SessionOutcome {
  file: string;
  /** Base64 bytes of images inside tool results. */
  imageBytes: number;
  /** Bytes of all tool results (text + image base64). */
  toolResultBytes: number;
  compactions: number;
  assistantTurns: number;
  stopError: number;
  stopLength: number;
  aborted: number;
  toolResults: number;
  toolErrors: number;
  /** An assistant turn failed with a context-overflow error text. */
  overflow: boolean;
}

/** Provider texts for a full context. Matched on assistant errorMessage only: tool output quotes source code. */
export const OVERFLOW_RE =
  /context[ _]length|context window|exceeds the (?:context|limit)|prompt is too long|maximum context|too many tokens|context overflow/i;

export function scanOutcome(file: string, lines: Iterable<string>): SessionOutcome {
  const o: SessionOutcome = {
    file,
    imageBytes: 0,
    toolResultBytes: 0,
    compactions: 0,
    assistantTurns: 0,
    stopError: 0,
    stopLength: 0,
    aborted: 0,
    toolResults: 0,
    toolErrors: 0,
    overflow: false,
  };
  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "compaction") o.compactions++;
    if (e.type !== "message") continue;
    const m = e.message;
    if (m?.role === "assistant") {
      o.assistantTurns++;
      if (m.stopReason === "error") o.stopError++;
      if (m.stopReason === "length") o.stopLength++;
      if (m.stopReason === "aborted") o.aborted++;
      if (typeof m.errorMessage === "string" && OVERFLOW_RE.test(m.errorMessage)) o.overflow = true;
    } else if (m?.role === "toolResult") {
      o.toolResults++;
      if (m.isError === true) o.toolErrors++;
      if (typeof m.content === "string") o.toolResultBytes += m.content.length;
      else if (Array.isArray(m.content))
        for (const p of m.content) {
          if (p?.type === "image") {
            const n = p.data?.length ?? 0;
            o.imageBytes += n;
            o.toolResultBytes += n;
          } else o.toolResultBytes += p?.text?.length ?? 0;
        }
    }
  }
  return o;
}

export const GROUPS = ["none", "<20%", "20-50%", ">50%"] as const;
export type Group = (typeof GROUPS)[number];

export function groupOf(s: Pick<SessionOutcome, "imageBytes" | "toolResultBytes">): Group {
  if (s.imageBytes === 0) return "none";
  const share = s.imageBytes / s.toolResultBytes;
  return share < 0.2 ? "<20%" : share <= 0.5 ? "20-50%" : ">50%";
}

export const BANDS = ["1-30", "31-100", "101-300", ">300"] as const;
export function bandOf(turns: number): string {
  return turns <= 30 ? BANDS[0] : turns <= 100 ? BANDS[1] : turns <= 300 ? BANDS[2] : BANDS[3];
}

export interface Rates {
  sessions: number;
  compactionsPerSession: number;
  turnsMean: number;
  turnsMedian: number;
  errorStopsPer100: number;
  lengthStopsPer100: number;
  toolErrorRate: number;
  abortedPer100: number;
  overflowShare: number;
}
export type Metric = Exclude<keyof Rates, "sessions">;
export const METRICS: Metric[] = [
  "compactionsPerSession",
  "turnsMean",
  "turnsMedian",
  "errorStopsPer100",
  "lengthStopsPer100",
  "toolErrorRate",
  "abortedPer100",
  "overflowShare",
];

const sum = (xs: SessionOutcome[], f: (x: SessionOutcome) => number) =>
  xs.reduce((a, x) => a + f(x), 0);
const div = (a: number, b: number) => (b === 0 ? 0 : a / b);
const med = (v: number[]) => {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Ratio-of-sums rates: long sessions weigh more, as they have more turns. */
export function ratesOf(g: SessionOutcome[]): Rates {
  const turns = sum(g, (x) => x.assistantTurns);
  return {
    sessions: g.length,
    compactionsPerSession: div(
      sum(g, (x) => x.compactions),
      g.length,
    ),
    turnsMean: div(turns, g.length),
    turnsMedian: med(g.map((x) => x.assistantTurns)),
    errorStopsPer100: (100 * sum(g, (x) => x.stopError)) / (turns || 1),
    lengthStopsPer100: (100 * sum(g, (x) => x.stopLength)) / (turns || 1),
    toolErrorRate: div(
      sum(g, (x) => x.toolErrors),
      sum(g, (x) => x.toolResults),
    ),
    abortedPer100: (100 * sum(g, (x) => x.aborted)) / (turns || 1),
    overflowShare: div(g.filter((x) => x.overflow).length, g.length),
  };
}

export function byGroup(sessions: SessionOutcome[]): Record<Group, Rates> {
  return Object.fromEntries(
    GROUPS.map((g) => [g, ratesOf(sessions.filter((s) => groupOf(s) === g))]),
  ) as Record<Group, Rates>;
}

export interface Adjusted {
  /** Sessions of the group inside strata that also hold a "none" comparison. */
  sessions: number;
  strata: number;
  /** Weighted mean over strata of (group rate - none rate); weight = group sessions. */
  diff: Record<Metric, number>;
}

/** Compare each image group with "none" inside each stratum, then average the differences. */
export function adjusted(
  sessions: SessionOutcome[],
  stratumOf: (s: SessionOutcome) => string,
  minPerCell = 5,
): Record<Exclude<Group, "none">, Adjusted> {
  const strata = new Map<string, SessionOutcome[]>();
  for (const s of sessions) strata.set(stratumOf(s), [...(strata.get(stratumOf(s)) ?? []), s]);
  const out = {} as Record<Exclude<Group, "none">, Adjusted>;
  for (const g of GROUPS.slice(1) as Exclude<Group, "none">[]) {
    const diff = Object.fromEntries(METRICS.map((m) => [m, 0])) as Record<Metric, number>;
    let w = 0;
    let used = 0;
    for (const xs of strata.values()) {
      const a = xs.filter((s) => groupOf(s) === g);
      const b = xs.filter((s) => groupOf(s) === "none");
      if (a.length < minPerCell || b.length < minPerCell) continue;
      const ra = ratesOf(a);
      const rb = ratesOf(b);
      for (const m of METRICS) diff[m] += a.length * (ra[m] - rb[m]);
      w += a.length;
      used++;
    }
    for (const m of METRICS) diff[m] = div(diff[m], w);
    out[g] = { sessions: w, strata: used, diff };
  }
  return out;
}

const f = (x: number, d = 2) => x.toFixed(d);
const HEAD = [
  "comp/s",
  "turns_mean",
  "turns_med",
  "errStop/100",
  "lenStop/100",
  "toolErr%",
  "abort/100",
  "overflow%",
];
const cells = (r: Rates | Record<Metric, number>) => [
  f(r.compactionsPerSession),
  f(r.turnsMean, 1),
  f(r.turnsMedian, 1),
  f(r.errorStopsPer100),
  f(r.lengthStopsPer100),
  f(100 * r.toolErrorRate),
  f(r.abortedPer100),
  f(100 * r.overflowShare),
];

export function formatImpact(
  sessions: SessionOutcome[],
  labelOf: (file: string) => string,
): string {
  const L: string[] = [];
  const row = (name: string, n: number | string, c: string[]) =>
    L.push(
      `  ${name.padEnd(8)} ${String(n).padStart(5)}  ${c.map((x, i) => x.padStart(HEAD[i]!.length)).join("  ")}`,
    );
  const head = () => L.push(`  ${"group".padEnd(8)} ${"sess".padStart(5)}  ${HEAD.join("  ")}`);
  L.push("pooled (no control):");
  head();
  const pooled = byGroup(sessions);
  for (const g of GROUPS) row(g, pooled[g].sessions, cells(pooled[g]));
  const adj = (title: string, stratumOf: (s: SessionOutcome) => string) => {
    L.push(
      "",
      `${title}: mean difference vs "none" inside each stratum (strata with >=5 sessions in both):`,
    );
    head();
    const a = adjusted(sessions, stratumOf);
    for (const g of GROUPS.slice(1) as Exclude<Group, "none">[])
      row(g, `${a[g].sessions}/${a[g].strata}`, cells(a[g].diff));
  };
  adj("within label", (s) => labelOf(s.file));
  adj("within turn band", (s) => bandOf(s.assistantTurns));
  adj("within label x turn band", (s) => `${labelOf(s.file)}|${bandOf(s.assistantTurns)}`);
  L.push("", "image-session share by label (sessions with image share >= 20%):");
  const labels = new Map<string, [number, number]>();
  for (const s of sessions) {
    const c = labels.get(labelOf(s.file)) ?? [0, 0];
    c[0]++;
    if (groupOf(s) === "20-50%" || groupOf(s) === ">50%") c[1]++;
    labels.set(labelOf(s.file), c);
  }
  for (const [k, [n, h]] of [...labels].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8))
    L.push(`  ${k.padEnd(20)} ${h}/${n}`);
  return L.join("\n");
}
