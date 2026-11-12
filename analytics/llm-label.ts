import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { LABELS, originOf, type Label } from "./label.ts";
import { redact } from "./redact.ts";
import type { SessionRow } from "./sessions.ts";

export const LLM_MODEL = "openrouter/anthropic/claude-haiku-5.5";
export const CACHE_FILE = new URL("./data/llm-labels.jsonl", import.meta.url).pathname;

export interface LlmLabel {
  file: string;
  label: Label;
  confidence: number;
  model: string;
}

export function buildPrompt(batch: SessionRow[]): string {
  const items = batch.map((s, i) => ({
    i,
    project: s.project.replace(/^--home-mpillet-/, "").replace(/--$/, ""),
    origin: originOf(s),
    shape: { edits: s.edits, bash: s.bash, reads: s.reads, turns: s.turns },
    firstMessage: redact(s.firstText).replace(/\s+/g, " ").slice(0, 700),
  }));
  return `Classify each coding-agent thread by the main task it handles.
Labels: ${LABELS.join(", ")}.
- explore-qa: questions, investigation, reports, no real code change wanted.
- implement: build or change code. diagnose: find the cause of a failure or bug.
- infra-ops: deploy, docker, k8s, CI, environment. other: none of the above.
Answer with ONLY a JSON array: [{"i":0,"label":"...","confidence":0.0-1.0}, ...] covering every item.

${JSON.stringify(items)}`;
}

export function parseAnswer(text: string, batch: SessionRow[]): LlmLabel[] {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: LlmLabel[] = [];
  for (const a of arr as { i?: number; label?: string; confidence?: number }[]) {
    const s = typeof a.i === "number" ? batch[a.i] : undefined;
    if (!s || !a.label || !(LABELS as readonly string[]).includes(a.label)) continue;
    out.push({
      file: s.file,
      label: a.label as Label,
      confidence: Number(a.confidence ?? 0),
      model: LLM_MODEL,
    });
  }
  return out;
}

function askModel(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("pi", ["-p", "--no-session", "-nt", "-ne", "-ns", "--model", LLM_MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`pi exited ${code}`))));
    p.stdin.end(prompt);
  });
}

export function loadCache(): Map<string, LlmLabel> {
  const m = new Map<string, LlmLabel>();
  if (!existsSync(CACHE_FILE)) return m;
  for (const line of readFileSync(CACHE_FILE, "utf8").split("\n")) {
    if (line) {
      const l = JSON.parse(line) as LlmLabel;
      m.set(l.file, l);
    }
  }
  return m;
}

/** Label sessions in batches, in parallel, appending to a cache so a rerun only pays for new sessions. */
export async function labelWithLlm(
  sessions: SessionRow[],
  opts: { batch?: number; parallel?: number; limit?: number } = {},
) {
  const cache = loadCache();
  const todo = sessions.filter((s) => !cache.has(s.file)).slice(0, opts.limit ?? Infinity);
  const size = opts.batch ?? 12;
  const batches: SessionRow[][] = [];
  for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++]!;
      try {
        const got = parseAnswer(await askModel(buildPrompt(b)), b);
        for (const l of got) {
          cache.set(l.file, l);
          appendFileSync(CACHE_FILE, `${JSON.stringify(l)}\n`);
        }
        if (got.length < b.length) failed++;
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: opts.parallel ?? 4 }, worker));
  return { cache, asked: todo.length, partialOrFailedBatches: failed };
}
