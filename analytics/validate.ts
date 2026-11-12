/** Hand-validation of task labels: seeded sample, blind review sheet, answer scoring. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { LABELS, labelByRules, originOf } from "./label.ts";
import { loadCache } from "./llm-label.ts";
import { redact } from "./redact.ts";
import type { SessionRow } from "./sessions.ts";

export const VALIDATION_DIR = new URL("./data/validation/", import.meta.url).pathname;
export const LLM_SHARE = 0.6;
export const MIN_PER_LABEL = 3;
export const BATCH = 20;

export interface SampleItem {
  n: number;
  file: string;
  project: string;
  firstText: string; // redacted, trimmed
  edits: number;
  bash: number;
  reads: number;
  turns: number;
  label: string;
  source: "rule" | "llm";
  confidence: number | null;
}

type Cand = Omit<SampleItem, "n">;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export const shortProject = (p: string) =>
  p.replace(/^--home-mpillet-/, "").replace(/--$/, "") || "home";

export const oneLine = (text: string, max = 220) => {
  const t = redact(text).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function confBucket(c: number): "<0.5" | "0.5-0.8" | ">0.8" {
  return c < 0.5 ? "<0.5" : c <= 0.8 ? "0.5-0.8" : ">0.8";
}

/** Candidates: human-origin sessions with a label from rules, else from the LLM cache. */
export function candidates(
  sessions: SessionRow[],
  cache: Map<string, { label: string; confidence: number }>,
): Cand[] {
  const out: Cand[] = [];
  for (const s of sessions) {
    if (originOf(s) !== "human" || !s.firstText.trim()) continue;
    const r = labelByRules(s);
    const l = r.label === null ? cache.get(s.file) : undefined;
    if (r.label === null && !l) continue;
    out.push({
      file: s.file,
      project: shortProject(s.project),
      firstText: oneLine(s.firstText),
      edits: s.edits,
      bash: s.bash,
      reads: s.reads,
      turns: s.turns,
      label: r.label ?? l!.label,
      source: r.label === null ? "llm" : "rule",
      confidence: r.label === null ? l!.confidence : null,
    });
  }
  return out;
}

/** Seeded stratified sample: >= MIN_PER_LABEL per label, ~60% LLM, LLM spread over confidence buckets. */
export function drawSample(pool: Cand[], n: number, seed: number): SampleItem[] {
  const rnd = mulberry32(seed);
  // sort first so the result never depends on input order
  const all = shuffle(
    [...pool].sort((a, b) => a.file.localeCompare(b.file)),
    rnd,
  );
  const target = Math.min(n, all.length);
  const picked = new Set<Cand>();
  for (const label of LABELS) {
    all
      .filter((c) => c.label === label)
      .slice(0, MIN_PER_LABEL)
      .forEach((c) => picked.add(c));
  }
  const rest = all.filter((c) => !picked.has(c));
  const count = (src: string) => [...picked].filter((c) => c.source === src).length;
  const llmWant = Math.round(target * LLM_SHARE) - count("llm");
  const ruleWant = target - Math.round(target * LLM_SHARE) - count("rule");
  const buckets = new Map<string, Cand[]>();
  for (const c of rest.filter((c) => c.source === "llm"))
    (
      buckets.get(confBucket(c.confidence!)) ??
      buckets.set(confBucket(c.confidence!), []).get(confBucket(c.confidence!))!
    ).push(c);
  const lists = [...buckets.keys()].sort().map((k) => buckets.get(k)!);
  let added = 0;
  while (added < llmWant && lists.some((l) => l.length)) {
    for (const l of lists) {
      if (added < llmWant && l.length) {
        picked.add(l.shift()!);
        added++;
      }
    }
  }
  const rules = rest.filter((c) => c.source === "rule");
  for (const c of rules.slice(0, Math.max(0, ruleWant))) picked.add(c);
  // one pool ran short: top up from whatever is left
  for (const c of rest) {
    if (picked.size >= target) break;
    picked.add(c);
  }
  return shuffle([...picked], rnd)
    .slice(0, Math.max(target, 0))
    .map((c, i) => ({ ...c, n: i + 1 }));
}

/** Review sheet. Never prints the model label, source or confidence. */
export function renderSheet(items: SampleItem[]): string {
  const out = [
    `# Label check (${items.length} threads)`,
    "",
    `Labels: ${LABELS.join(", ")}`,
    "",
    "Reply with one line per number: `<number> <label>`, e.g. `12 implement`. Use `<number> skip` if unsure.",
  ];
  items.forEach((it, i) => {
    if (i % BATCH === 0) out.push("", `## Batch ${i / BATCH + 1}`, "");
    out.push(
      `${it.n}. [${it.project}] ${it.firstText || "(empty)"}`,
      `   edits ${it.edits} · bash ${it.bash} · reads ${it.reads} · turns ${it.turns}`,
    );
  });
  return `${out.join("\n")}\n`;
}

export interface ParsedAnswers {
  answers: Map<number, string>; // label or "skip"
  errors: string[];
}

export function parseAnswers(text: string, validNumbers?: Set<number>): ParsedAnswers {
  const answers = new Map<number, string>();
  const errors: string[] = [];
  text.split("\n").forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^(\d+)\s*[.:)]?\s+([A-Za-z][A-Za-z-]*)\s*[.!]?$/.exec(line);
    if (!m) return void errors.push(`line ${idx + 1}: cannot parse "${line}"`);
    const n = Number(m[1]);
    const word = m[2]!.toLowerCase();
    if (validNumbers && !validNumbers.has(n))
      return void errors.push(`line ${idx + 1}: no item ${n}`);
    if (word !== "skip" && !(LABELS as readonly string[]).includes(word))
      return void errors.push(`line ${idx + 1}: unknown label "${m[2]}"`);
    if (answers.has(n)) errors.push(`line ${idx + 1}: item ${n} answered twice, last one used`);
    answers.set(n, word);
  });
  return { answers, errors };
}

const acc = (ok: number, n: number) => (n ? `${((100 * ok) / n).toFixed(1)}% (${ok}/${n})` : "n/a");

export interface Score {
  scored: number;
  correct: number;
  skipped: number;
  unanswered: number;
  bySource: Record<"rule" | "llm", { ok: number; n: number }>;
  byConf: Record<string, { ok: number; n: number }>;
  confusion: { truth: string; model: string; n: number }[]; // truth = owner label
  wrong: (SampleItem & { truth: string })[];
}

export function scoreAnswers(items: SampleItem[], answers: Map<number, string>): Score {
  const s: Score = {
    scored: 0,
    correct: 0,
    skipped: 0,
    unanswered: 0,
    bySource: { rule: { ok: 0, n: 0 }, llm: { ok: 0, n: 0 } },
    byConf: { "<0.5": { ok: 0, n: 0 }, "0.5-0.8": { ok: 0, n: 0 }, ">0.8": { ok: 0, n: 0 } },
    confusion: [],
    wrong: [],
  };
  const pairs = new Map<string, number>();
  for (const it of items) {
    const a = answers.get(it.n);
    if (a === undefined) {
      s.unanswered++;
      continue;
    }
    if (a === "skip") {
      s.skipped++;
      continue;
    }
    const ok = a === it.label ? 1 : 0;
    s.scored++;
    s.correct += ok;
    s.bySource[it.source].n++;
    s.bySource[it.source].ok += ok;
    if (it.source === "llm") {
      const b = s.byConf[confBucket(it.confidence ?? 0)]!;
      b.n++;
      b.ok += ok;
    }
    if (!ok) {
      s.wrong.push({ ...it, truth: a });
      const k = `${a}\t${it.label}`;
      pairs.set(k, (pairs.get(k) ?? 0) + 1);
    }
  }
  s.confusion = [...pairs]
    .map(([k, n]) => ({ truth: k.split("\t")[0]!, model: k.split("\t")[1]!, n }))
    .sort((a, b) => b.n - a.n || a.truth.localeCompare(b.truth));
  return s;
}

export function renderReport(items: SampleItem[], s: Score, errors: string[]): string {
  const o = [
    "# Label validation report",
    "",
    `Scored ${s.scored} of ${items.length} (skipped ${s.skipped}, unanswered ${s.unanswered}).`,
    `- Overall accuracy: ${acc(s.correct, s.scored)}`,
    `- Rule labels: ${acc(s.bySource.rule.ok, s.bySource.rule.n)}`,
    `- LLM labels: ${acc(s.bySource.llm.ok, s.bySource.llm.n)}`,
    "",
    "## LLM accuracy by confidence",
    ...Object.entries(s.byConf).map(([k, v]) => `- ${k}: ${acc(v.ok, v.n)}`),
    "",
    "## Most confused (you said → label said)",
    ...(s.confusion.length
      ? s.confusion.slice(0, 10).map((c) => `- ${c.truth} → ${c.model}: ${c.n}`)
      : ["- none"]),
    "",
    `## Wrong items (${s.wrong.length})`,
    ...(s.wrong.length
      ? s.wrong.map(
          (w) =>
            `- ${w.n}. you: ${w.truth}; label: ${w.label} (${w.source}${w.confidence === null ? "" : ` ${w.confidence}`}) — ${w.firstText}`,
        )
      : ["- none"]),
  ];
  if (errors.length)
    o.push("", `## Answer errors (${errors.length})`, ...errors.map((e) => `- ${e}`));
  return `${o.join("\n")}\n`;
}

export async function runSample(sessions: SessionRow[], n: number, seed: number) {
  const items = drawSample(candidates(sessions, loadCache()), n, seed);
  mkdirSync(VALIDATION_DIR, { recursive: true });
  writeFileSync(`${VALIDATION_DIR}sample.json`, `${JSON.stringify(items, null, 1)}\n`);
  writeFileSync(`${VALIDATION_DIR}sample.md`, renderSheet(items));
  return items;
}

export function runScore(answersFile: string): string {
  const items = JSON.parse(readFileSync(`${VALIDATION_DIR}sample.json`, "utf8")) as SampleItem[];
  const { answers, errors } = parseAnswers(
    readFileSync(answersFile, "utf8"),
    new Set(items.map((i) => i.n)),
  );
  const report = renderReport(items, scoreAnswers(items, answers), errors);
  writeFileSync(`${VALIDATION_DIR}report.md`, report);
  return report;
}
