/** Cost tail of sessions. Pure: per-session raw facts in, features and comparisons out. */
import { computeCost, type MessageUsage } from "./cost.ts";
import { median, percentile } from "./profile.ts";
import { priceFor, PRICES, type Price } from "./prices.ts";

export interface TailInput {
  file: string;
  label: string;
  origin: string;
  /** Assistant messages with usage. Cost and cost split come from these. */
  usage: MessageUsage[];
  /** Tool name -> calls. */
  toolCalls: Record<string, number>;
  /** Raw bash command lines. Only classified, never printed. */
  bashCommands: string[];
  /** Paths of read calls, in order. */
  readPaths: string[];
  /** Result size in bytes of each read call, parallel to readPaths. */
  readBytes?: number[];
  /** Parallel to readPaths: true when the path was edited or written since its previous read. */
  readAfterEdit?: boolean[];
  compactions: number;
  userMessages: number;
  aborts: number;
  toolErrors: number;
  retryLoops: number;
  /** Message timestamps in ms, ascending. */
  timestamps: number[];
}

export const BASH_CLASSES = ["tests", "build", "lint", "git", "poll", "devServer"] as const;
export type BashClass = (typeof BASH_CLASSES)[number];

const BASH_RULES: [BashClass, RegExp][] = [
  ["poll", /(^|[\s;&|(])(sleep|until|watch)\s|while\s+(true|:|\[)|gh\s+(pr|run)\s+(checks|watch)/],
  [
    "devServer",
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\bvite\b(?!\s+build)|next\s+dev|\bnodemon\b|http\.server|\bserve\b/,
  ],
  [
    "tests",
    /\b(vitest|jest|pytest|mocha|playwright)\b|\b(bun|go|cargo|npm|pnpm|yarn|mvn|gradle)\b[^;&|]*\stest\b|\btest:/,
  ],
  ["lint", /\b(eslint|prettier|biome|oxlint|ruff|lint|fmt|format)\b/],
  [
    "build",
    /\b(tsc|tsgo|typecheck|cargo\s+(build|check)|go\s+build|make|webpack|esbuild)\b|\b(npm|pnpm|yarn|bun)\b[^;&|]*\s(build|check)\b/,
  ],
  ["git", /(^|[\s;&|(])(git|gh)\s/],
];

/** Every class a command line matches (a chain like `lint && test` counts for both). */
export function classifyBash(cmd: string): BashClass[] {
  return BASH_RULES.filter(([, re]) => re.test(cmd)).map(([c]) => c);
}

export interface CostSplit {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output tokens; includes reasoning, which the log already counts in `output`. */
  output: number;
}

const M = 1e6;
function tierPrice(price: Price, prompt: number): Price {
  const t = price.tiers
    ?.filter((x) => prompt > x.inputTokensAbove)
    .sort((a, b) => b.inputTokensAbove - a.inputTokensAbove)[0];
  return t ?? price;
}

/** USD per token kind. Unpriced models add nothing. Sum equals cost.ts `computeCost`. */
export function costSplit(msgs: MessageUsage[]): CostSplit {
  const s: CostSplit = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const m of msgs) {
    const base = priceFor(m.model, PRICES);
    if (!base) continue;
    const u = { i: m.input ?? 0, r: m.cacheRead ?? 0, w: m.cacheWrite ?? 0, o: m.output ?? 0 };
    const p = tierPrice(base, u.i + u.r + u.w);
    s.input += (u.i * p.input) / M;
    s.cacheRead += (u.r * p.cacheRead) / M;
    s.cacheWrite += (u.w * p.cacheWrite) / M;
    s.output += (u.o * p.output) / M;
  }
  return s;
}

export const IDLE_GAP_MS = 5 * 60_000;

export interface TailSession {
  file: string;
  cost: number;
  split: CostSplit;
  models: string[];
  /** All numeric features, by name. */
  f: Record<string, number>;
}

/** Number of repeated reads: reads of a path already read in the same session. */
export const repeatReads = (paths: string[]) => paths.length - new Set(paths).size;

export function sessionTail(s: TailInput): TailSession {
  const split = costSplit(s.usage);
  const cost = s.usage.reduce((a, m) => a + (computeCost(m, m.model) ?? 0), 0);
  const turns = s.usage.length;
  const sumTok = (k: "input" | "cacheRead" | "cacheWrite" | "output") =>
    s.usage.reduce((a, m) => a + (m[k] ?? 0), 0);
  const prompt = sumTok("input") + sumTok("cacheRead") + sumTok("cacheWrite");
  const ts = s.timestamps;
  const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
  const idle = gaps.filter((g) => g > IDLE_GAP_MS);
  const bash = Object.fromEntries(BASH_CLASSES.map((c) => [c, 0])) as Record<BashClass, number>;
  for (const c of s.bashCommands) for (const k of classifyBash(c)) bash[k]++;
  const toolCalls = Object.values(s.toolCalls).reduce((a, b) => a + b, 0);
  const delegates = Object.entries(s.toolCalls)
    .filter(([k]) => k.endsWith("delegate_task"))
    .reduce((a, [, v]) => a + v, 0);
  const f: Record<string, number> = {
    turns,
    toolCalls,
    wallMin: ts.length > 1 ? (ts.at(-1)! - ts[0]!) / 60_000 : 0,
    models: new Set(s.usage.map((m) => m.model)).size,
    maxContextK: Math.max(0, ...s.usage.map((m) => (m.input + m.cacheRead + m.cacheWrite) / 1e3)),
    compactions: s.compactions,
    cacheReadShare: prompt > 0 ? sumTok("cacheRead") / prompt : 0,
    outputTokK: sumTok("output") / 1e3,
    bashCalls: s.toolCalls["bash"] ?? 0,
    readCalls: s.toolCalls["read"] ?? 0,
    editCalls: (s.toolCalls["edit"] ?? 0) + (s.toolCalls["write"] ?? 0),
    ...Object.fromEntries(BASH_CLASSES.map((c) => [`bash_${c}`, bash[c]])),
    retryLoops: s.retryLoops,
    toolErrors: s.toolErrors,
    userMessages: s.userMessages,
    aborts: s.aborts,
    delegateCalls: delegates,
    repeatReads: repeatReads(s.readPaths),
    idleGaps5m: idle.length,
    idleMin: idle.reduce((a, b) => a + b, 0) / 60_000,
  };
  return {
    file: s.file,
    cost,
    split,
    models: [...new Set(s.usage.map((m) => m.model))],
    f,
  };
}

/** Average ranks (ties share the mean rank). */
export function ranks(xs: number[]): number[] {
  const idx = xs.map((_, i) => i).sort((a, b) => xs[a]! - xs[b]!);
  const r: number[] = Array.from({ length: xs.length }, () => 0);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && xs[idx[j + 1]!] === xs[idx[i]!]) j++;
    for (let k = i; k <= j; k++) r[idx[k]!] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let sab = 0,
    saa = 0,
    sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa === 0 || sbb === 0 ? 0 : sab / Math.sqrt(saa * sbb);
}

export const spearman = (a: number[], b: number[]) => pearson(ranks(a), ranks(b));

/** Residuals of y after a least-squares line on x. */
function residuals(y: number[], x: number[]): number[] {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0,
    sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return y.map((v, i) => v - my - b * (x[i]! - mx));
}

/** Spearman of a and b after removing the rank trend of `control` from both. */
export function partialSpearman(a: number[], b: number[], control: number[]): number {
  const c = ranks(control);
  return pearson(residuals(ranks(a), c), residuals(ranks(b), c));
}

export interface Bucket {
  name: string;
  n: number;
  costTotal: number;
  costMedian: number;
  /** Medians of per-session ratios. */
  costPerTurn: number;
  costPerUserMsg: number;
  split: CostSplit;
  /** Median of each feature. */
  med: Record<string, number>;
}

export interface FeatureEffect {
  name: string;
  /** Spearman with cost, all sessions. */
  rho: number;
  /** Spearman with cost after controlling for turns. */
  rhoTurns: number;
  medTop20: number;
  medBottom50: number;
  /** Cliff's delta, top 20% vs bottom 50%: P(top>bottom) - P(top<bottom). Range -1..1. */
  cliff: number;
  /** Cliff's delta among sessions with similar turns (same turns quintile), pooled. */
  cliffSameTurns: number;
}

export interface TailReport {
  n: number;
  total: number;
  top5: Bucket;
  top20: Bucket;
  bottom50: Bucket;
  effects: FeatureEffect[];
  /** Best three features by |rhoTurns|, cost-mechanical ones excluded. */
  best: string[];
  /** Per best feature: top-cost sessions with the highest feature value. */
  examples: Record<string, { file: string; cost: number; value: number; turns: number }[]>;
  top: TailSession[];
}

/** Features that are cost by construction or just size: never reported as an explanation. */
export const NOT_EXPLANATORY = new Set(["turns", "toolCalls", "outputTokK"]);

const sumSplit = (xs: TailSession[]): CostSplit => ({
  input: xs.reduce((a, x) => a + x.split.input, 0),
  cacheRead: xs.reduce((a, x) => a + x.split.cacheRead, 0),
  cacheWrite: xs.reduce((a, x) => a + x.split.cacheWrite, 0),
  output: xs.reduce((a, x) => a + x.split.output, 0),
});

function bucket(name: string, xs: TailSession[]): Bucket {
  const names = Object.keys(xs[0]?.f ?? {});
  return {
    name,
    n: xs.length,
    costTotal: xs.reduce((a, x) => a + x.cost, 0),
    costMedian: median(xs.map((x) => x.cost)),
    costPerTurn: median(xs.map((x) => x.cost / Math.max(1, x.f["turns"]!))),
    costPerUserMsg: median(xs.map((x) => x.cost / Math.max(1, x.f["userMessages"]!))),
    split: sumSplit(xs),
    med: Object.fromEntries(names.map((k) => [k, median(xs.map((x) => x.f[k]!))])),
  };
}

export function cliffDelta(a: number[], b: number[]): number {
  if (!a.length || !b.length) return 0;
  let gt = 0,
    lt = 0;
  for (const x of a)
    for (const y of b) {
      if (x > y) gt++;
      else if (x < y) lt++;
    }
  return (gt - lt) / (a.length * b.length);
}

export function buildTail(
  sessions: TailSession[],
  opts: { top?: number; minCost?: number } = {},
): TailReport {
  const sorted = [...sessions].sort((a, b) => b.cost - a.cost || a.file.localeCompare(b.file));
  const n = sorted.length;
  const cut = (p: number) => Math.max(1, Math.ceil(n * p));
  const t5 = sorted.slice(0, cut(0.05));
  const t20 = sorted.slice(0, cut(0.2));
  const b50 = sorted.slice(n - cut(0.5));
  const names = Object.keys(sorted[0]?.f ?? {});
  const costs = sorted.map((s) => s.cost);
  const turns = sorted.map((s) => s.f["turns"]!);
  // Turns quintile of each session, to compare like with like.
  const tr = ranks(turns);
  const q = (i: number) => Math.min(4, Math.floor(((tr[i]! - 1) / n) * 5));
  const top20Set = new Set(t20.map((s) => s.file));
  const bot50Set = new Set(b50.map((s) => s.file));
  const effects = names.map((k): FeatureEffect => {
    const v = sorted.map((s) => s.f[k]!);
    let num = 0,
      den = 0;
    for (let g = 0; g < 5; g++) {
      const ta = sorted.flatMap((s, i) => (q(i) === g && top20Set.has(s.file) ? [s.f[k]!] : []));
      const tb = sorted.flatMap((s, i) => (q(i) === g && bot50Set.has(s.file) ? [s.f[k]!] : []));
      num += cliffDelta(ta, tb) * ta.length * tb.length;
      den += ta.length * tb.length;
    }
    return {
      name: k,
      rho: spearman(v, costs),
      rhoTurns: partialSpearman(v, costs, turns),
      medTop20: median(t20.map((s) => s.f[k]!)),
      medBottom50: median(b50.map((s) => s.f[k]!)),
      cliff: cliffDelta(
        t20.map((s) => s.f[k]!),
        b50.map((s) => s.f[k]!),
      ),
      cliffSameTurns: den ? num / den : 0,
    };
  });
  const best = effects
    .filter((e) => !NOT_EXPLANATORY.has(e.name))
    .sort((a, b) => Math.abs(b.rhoTurns) - Math.abs(a.rhoTurns))
    .slice(0, 3)
    .map((e) => e.name);
  const examples: TailReport["examples"] = {};
  for (const k of best)
    examples[k] = [...t20]
      .sort((a, b) => b.f[k]! - a.f[k]! || b.cost - a.cost)
      .slice(0, 2)
      .map((s) => ({ file: s.file, cost: s.cost, value: s.f[k]!, turns: s.f["turns"]! }));
  return {
    n,
    total: costs.reduce((a, b) => a + b, 0),
    top5: bucket("top5%", t5),
    top20: bucket("top20%", t20),
    bottom50: bucket("bottom50%", b50),
    effects,
    best,
    examples,
    top: sorted.slice(0, opts.top ?? 5),
  };
}

const f = (x: number, d = 2) => x.toFixed(d);
const usd = (x: number) => `$${f(x)}`;

export function formatTail(r: TailReport, label: string): string {
  const out: string[] = [];
  out.push(`${label}: ${r.n} sessions, total ${usd(r.total)} (priced tokens only)`);
  out.push("bucket     n   $total  share  $med  $/turn  $/usermsg  input% cacheR% cacheW% output%");
  for (const b of [r.top5, r.top20, r.bottom50]) {
    const t = b.split.input + b.split.cacheRead + b.split.cacheWrite + b.split.output || 1;
    out.push(
      [
        b.name.padEnd(9),
        String(b.n).padStart(4),
        f(b.costTotal, 0).padStart(7),
        `${f((100 * b.costTotal) / r.total, 0)}%`.padStart(5),
        f(b.costMedian).padStart(5),
        f(b.costPerTurn, 3).padStart(6),
        f(b.costPerUserMsg).padStart(9),
        ...[b.split.input, b.split.cacheRead, b.split.cacheWrite, b.split.output].map((x) =>
          f((100 * x) / t, 0).padStart(7),
        ),
      ].join(" "),
    );
  }
  out.push("");
  out.push("feature            rho   rho|turns  med_top20  med_bot50  cliff  cliff|sameTurns");
  for (const e of [...r.effects].sort((a, b) => Math.abs(b.rhoTurns) - Math.abs(a.rhoTurns)))
    out.push(
      [
        e.name.padEnd(16),
        f(e.rho).padStart(6),
        f(e.rhoTurns).padStart(10),
        f(e.medTop20, 1).padStart(10),
        f(e.medBottom50, 1).padStart(10),
        f(e.cliff).padStart(6),
        f(e.cliffSameTurns).padStart(10),
      ].join(" "),
    );
  out.push("");
  out.push(`best 3 after turns control: ${r.best.join(", ")}`);
  for (const k of r.best)
    for (const x of r.examples[k]!)
      out.push(`  ${k}=${f(x.value, 1)} cost ${usd(x.cost)} turns ${x.turns} ${x.file}`);
  out.push("");
  out.push(`top ${r.top.length} by cost`);
  for (const s of r.top)
    out.push(`  ${usd(s.cost)} turns ${s.f["turns"]} ${s.models.join(",")} ${s.file}`);
  return out.join("\n");
}

export interface Intervention {
  name: string;
  savingUsd: number;
  assumption: string;
  /** What the data can check without a live A/B test. */
  testable: string;
}

/** USD per cached or written token of one message; 0 when unpriced or no such tokens. */
function rate(m: MessageUsage, k: "cacheRead" | "cacheWrite"): number {
  const n = m[k] ?? 0;
  return n > 0 ? costSplit([m])[k] / n : 0;
}

/** Replay: no message sends more than `capK` thousand prompt tokens. Upper bound, minus one cold restart per session that crosses. */
export function contextCapSaving(inputs: TailInput[], capK: number): number {
  const cap = capK * 1e3;
  let saved = 0;
  for (const s of inputs) {
    let crossed: MessageUsage | undefined;
    for (const m of s.usage) {
      const p = m.input + m.cacheRead + m.cacheWrite;
      if (p <= cap) continue;
      crossed ??= m;
      saved += costSplit([m]).cacheRead * ((p - cap) / p);
    }
    if (crossed) saved -= cap * rate(crossed, "cacheWrite");
  }
  return saved;
}

/** Each repeat read adds its result (bytes/4 tokens) to the context for ~half of the session turns, billed at cache-read rate. */
export function repeatReadCost(s: TailInput): number {
  if (!s.readBytes || s.usage.length === 0) return 0;
  const seen = new Set<string>();
  let tokens = 0;
  s.readPaths.forEach((p, i) => {
    if (seen.has(p) && !s.readAfterEdit?.[i]) tokens += (s.readBytes![i] ?? 0) / 4;
    seen.add(p);
  });
  const reads = s.usage.reduce((a, m) => a + m.cacheRead, 0);
  const price = reads > 0 ? costSplit(s.usage).cacheRead / reads : 0;
  return tokens * price * (s.usage.length / 2);
}

/** Each idle gap over 5 min makes the next turn re-write the cached prompt instead of reading it. */
export function idleGapCost(s: TailInput): number {
  const gaps = s.timestamps.slice(1).filter((t, i) => t - s.timestamps[i]! > IDLE_GAP_MS).length;
  if (gaps === 0 || s.usage.length === 0) return 0;
  const sp = costSplit(s.usage);
  const w = s.usage.reduce((a, m) => a + m.cacheWrite, 0);
  const r = s.usage.reduce((a, m) => a + m.cacheRead, 0);
  if (w === 0 || r === 0) return 0;
  const avgPrompt = (r + w) / s.usage.length;
  return gaps * avgPrompt * Math.max(0, sp.cacheWrite / w - sp.cacheRead / r);
}

export function interventions(inputs: TailInput[], capK = 300): Intervention[] {
  return [
    ...[capK, capK / 2].map((k) => ({
      name: `compact or restart before ${k}K context`,
      savingUsd: contextCapSaving(inputs, k),
      assumption: `cache-read cost above ${k}K removed; one cold ${k}K rewrite per session that crosses; summary quality loss ignored`,
      testable: "replay on logged tokens only; behaviour effect needs an A/B",
    })),
    {
      name: "block re-reads of unchanged paths",
      savingUsd: inputs.reduce((a, s) => a + repeatReadCost(s), 0),
      assumption:
        "all repeat reads with no edit of that path in between avoidable; result stays in context for half of the turns",
      testable: "yes: re-read events and sizes are logged; upper bound",
    },
    {
      name: "keep cache warm or avoid idle gaps over 5 min",
      savingUsd: inputs.reduce((a, s) => a + idleGapCost(s), 0),
      assumption: "every gap over 5 min costs one average prompt at (write - read) price",
      testable:
        "partly: gap and next-turn cacheWrite are logged; cache TTL per provider is assumed",
    },
  ].sort((a, b) => b.savingUsd - a.savingUsd);
}

export { percentile };

export function formatInterventions(xs: Intervention[]): string {
  return [
    "",
    "candidate interventions (USD over all sessions in scope)",
    ...xs.map(
      (x, i) =>
        `${i + 1}. ${x.name}: ~${usd(x.savingUsd)}\n   assumption: ${x.assumption}\n   testable: ${x.testable}`,
    ),
  ].join("\n");
}
