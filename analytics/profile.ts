/** Per-label profile table. Pure aggregation: plain per-session rows in, table rows out. */

export interface SessionProfileInput {
  label: string;
  origin: string;
  assistantTurns: number;
  toolCalls: number;
  toolResults: number;
  errors: number;
  toolingErrors: number;
  readBytes: number;
  rereadBytes: number;
  retryLoops: number;
  delegateCalls: number;
  /** Recomputed USD for priced tokens only. */
  cost: number;
  /** Tokens of models with no known price. Their cost is missing, not zero. */
  unpricedTokens: number;
}

export interface ProfileRow {
  label: string;
  origin: string;
  sessions: number;
  turnsMedian: number;
  turnsP90: number;
  toolCallsPerSession: number;
  errorRate: number;
  toolingErrorRate: number;
  readMbPerSession: number;
  rereadMbPerSession: number;
  loopsPer100: number;
  delegatesPerSession: number;
  costMean: number;
  costMedian: number;
  costTotal: number;
  /** Sessions with unpriced tokens: costs above are lower bounds for these. */
  unpricedSessions: number;
}

/** Nearest-rank percentile, p in (0, 100]. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

/** Median: mean of the two middle values for even counts. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const sum = (xs: SessionProfileInput[], f: (x: SessionProfileInput) => number) =>
  xs.reduce((a, x) => a + f(x), 0);
const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);

export function buildProfile(sessions: SessionProfileInput[]): ProfileRow[] {
  const groups = new Map<string, SessionProfileInput[]>();
  for (const s of sessions) {
    const key = `${s.label}\u0000${s.origin}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const MB = 1e6;
  const out = [...groups.values()].map((g): ProfileRow => {
    const n = g.length;
    const turns = g.map((x) => x.assistantTurns);
    return {
      label: g[0]!.label,
      origin: g[0]!.origin,
      sessions: n,
      turnsMedian: median(turns),
      turnsP90: percentile(turns, 90),
      toolCallsPerSession: sum(g, (x) => x.toolCalls) / n,
      errorRate: ratio(
        sum(g, (x) => x.errors),
        sum(g, (x) => x.toolResults),
      ),
      toolingErrorRate: ratio(
        sum(g, (x) => x.toolingErrors),
        sum(g, (x) => x.toolResults),
      ),
      readMbPerSession: sum(g, (x) => x.readBytes) / MB / n,
      rereadMbPerSession: sum(g, (x) => x.rereadBytes) / MB / n,
      loopsPer100: (100 * sum(g, (x) => x.retryLoops)) / n,
      delegatesPerSession: sum(g, (x) => x.delegateCalls) / n,
      costMean: sum(g, (x) => x.cost) / n,
      costMedian: median(g.map((x) => x.cost)),
      costTotal: sum(g, (x) => x.cost),
      unpricedSessions: g.filter((x) => x.unpricedTokens > 0).length,
    };
  });
  return out.sort(
    (a, b) =>
      a.origin.localeCompare(b.origin) || b.sessions - a.sessions || a.label.localeCompare(b.label),
  );
}

export function formatProfile(rows: ProfileRow[]): string {
  const head = [
    "label",
    "origin",
    "sess",
    "turns_med",
    "turns_p90",
    "calls/s",
    "err%",
    "tooling_err%",
    "readMB/s",
    "rereadMB/s",
    "loops/100s",
    "deleg/s",
    "$mean",
    "$med",
    "$total",
    "unpriced_s",
  ];
  const f = (x: number, d = 1) => x.toFixed(d);
  const body = rows.map((r) => [
    r.label,
    r.origin,
    String(r.sessions),
    f(r.turnsMedian),
    f(r.turnsP90, 0),
    f(r.toolCallsPerSession),
    f(100 * r.errorRate),
    f(100 * r.toolingErrorRate),
    f(r.readMbPerSession),
    f(r.rereadMbPerSession, 2),
    f(r.loopsPer100),
    f(r.delegatesPerSession, 2),
    f(r.costMean, 2),
    f(r.costMedian, 2),
    f(r.costTotal, 0) + (r.unpricedSessions > 0 ? "*" : ""),
    String(r.unpricedSessions),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (c: string[]) =>
    c.map((v, i) => (i < 2 ? v.padEnd(w[i]!) : v.padStart(w[i]!))).join("  ");
  return [line(head), ...body.map(line)].join("\n");
}
