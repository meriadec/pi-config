import { expect, test } from "bun:test";
import { LABELS } from "./label.ts";
import {
  candidates,
  compareLabels,
  drawSample,
  refreshSample,
  type CompareRow,
  parseAnswers,
  renderSheet,
  scoreAnswers,
  type SampleItem,
} from "./validate.ts";

type Cand = Omit<SampleItem, "n">;
const mk = (i: number, label: string, source: "rule" | "llm", confidence: number | null): Cand => ({
  file: `/f/${String(i).padStart(4, "0")}`,
  project: "p",
  firstText: `msg ${i}`,
  edits: 1,
  bash: 2,
  reads: 3,
  turns: 4,
  label,
  source,
  confidence,
});
const pool: Cand[] = Array.from({ length: 400 }, (_, i) => {
  const label = LABELS[i % LABELS.length]!;
  return i % 3 === 0
    ? mk(i, label, "llm", [0.3, 0.65, 0.95][((i % 9) / 3) | 0]!)
    : mk(i, label, "rule", null);
});

test("same seed gives same sample, other seed differs, input order is irrelevant", () => {
  const a = drawSample(pool, 60, 1);
  expect(drawSample([...pool].reverse(), 60, 1)).toEqual(a);
  expect(drawSample(pool, 60, 2).map((x) => x.file)).not.toEqual(a.map((x) => x.file));
});

test("each label has at least 3 items, size and LLM share are respected", () => {
  const s = drawSample(pool, 60, 1);
  expect(s).toHaveLength(60);
  for (const l of LABELS) expect(s.filter((x) => x.label === l).length).toBeGreaterThanOrEqual(3);
  const llm = s.filter((x) => x.source === "llm").length;
  expect(llm).toBeGreaterThanOrEqual(30);
  expect(s.some((x) => x.source === "llm" && x.confidence! < 0.5)).toBe(true);
  expect(s.map((x) => x.n)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
});

test("sheet never leaks label, source or confidence; batches of 20", () => {
  const items = drawSample(pool, 45, 1).map((x) => ({
    ...x,
    label: "zzsecretlabel",
  }));
  const md = renderSheet(items);
  expect(md).not.toContain("zzsecretlabel");
  expect(md).not.toMatch(/confidence|\bllm\b|\brule\b/i);
  expect(md.match(/^## Batch/gm)).toHaveLength(3);
  expect(md).toContain("1. [p] msg");
});

test("parser is tolerant, and reports bad lines instead of guessing", () => {
  const r = parseAnswers(
    "12  Implement.\n3 SKIP\n4: diagnose\n\n5 implemnt\nhello\n99 design\n3 other",
    new Set([3, 4, 5, 12]),
  );
  expect(r.answers.get(12)).toBe("implement");
  expect(r.answers.get(4)).toBe("diagnose");
  expect(r.answers.get(3)).toBe("other");
  expect(r.answers.has(5)).toBe(false);
  expect(r.errors.join("\n")).toMatch(/unknown label "implemnt"/);
  expect(r.errors.join("\n")).toMatch(/cannot parse "hello"/);
  expect(r.errors.join("\n")).toMatch(/no item 99/);
  expect(r.errors.join("\n")).toMatch(/item 3 answered twice/);
});

test("skip is excluded from accuracy; buckets and confusion are right", () => {
  const items: SampleItem[] = [
    { ...mk(1, "implement", "rule", null), n: 1 },
    { ...mk(2, "implement", "llm", 0.3), n: 2 },
    { ...mk(3, "design", "llm", 0.9), n: 3 },
    { ...mk(4, "design", "llm", 0.9), n: 4 },
    { ...mk(5, "design", "llm", 0.6), n: 5 },
  ];
  const s = scoreAnswers(
    items,
    new Map([
      [1, "implement"],
      [2, "diagnose"],
      [3, "design"],
      [4, "skip"],
    ]),
  );
  expect(s.scored).toBe(3);
  expect(s.correct).toBe(2);
  expect(s.skipped).toBe(1);
  expect(s.unanswered).toBe(1);
  expect(s.bySource).toEqual({ rule: { ok: 1, n: 1 }, llm: { ok: 1, n: 2 } });
  expect(s.byConf["<0.5"]).toEqual({ ok: 0, n: 1 });
  expect(s.byConf[">0.8"]).toEqual({ ok: 1, n: 1 });
  expect(s.confusion).toEqual([{ truth: "diagnose", model: "implement", n: 1 }]);
  expect(s.wrong.map((w) => w.n)).toEqual([2]);
});

test("candidates skip delegated children and empty first messages", () => {
  const s = (firstText: string) =>
    ({
      file: firstText,
      project: "--home-mpillet-x--",
      firstSkill: "tdd",
      firstText,
      edits: 0,
      bash: 0,
      reads: 0,
      turns: 1,
      startedAt: "",
    }) as never;
  const c = candidates(
    [s("hello"), s("  "), s("Act as the implementation sub-agent for x")],
    new Map(
      ["hello", "  ", "Act as the implementation sub-agent for x"].map((f) => [
        f,
        { label: "design", confidence: 0.9 },
      ]),
    ),
  );
  expect(c.map((x) => x.file)).toEqual(["hello"]);
  // a skill (tdd) must not decide: the cached LLM label does
  expect(c[0]!.label).toBe("design");
});

test("refresh changes labels but never membership, numbers or order", () => {
  const items: SampleItem[] = [
    { ...mk(1, "design", "rule", null), n: 7 },
    { ...mk(2, "implement", "llm", 0.4), n: 3 },
  ];
  const sessions = items.map((i) => ({
    ...i,
    firstSkill: i.n === 7 ? "codebase-design" : null,
    startedAt: "",
    lastText: "",
  })) as never;
  const cache = new Map([
    [items[0]!.file, { label: "code-review", confidence: 0.9 }],
    [items[1]!.file, { label: "implement", confidence: 0.8 }],
  ]);
  const out = refreshSample(items, sessions, cache);
  expect(out.map((i) => [i.n, i.file])).toEqual(items.map((i) => [i.n, i.file]));
  expect(out[0]).toMatchObject({
    label: "code-review",
    oldLabel: "design",
    oldBy: "skill",
    confidence: 0.9,
  });
  expect(out[1]).toMatchObject({
    label: "implement",
    oldLabel: "implement",
    oldBy: "llm",
  });
  // second refresh keeps the original old label
  expect(refreshSample(out, sessions, cache)[0]!.oldLabel).toBe("design");
  expect(() => refreshSample(items, sessions, new Map())).toThrow();
});

test("score reports new and old accuracy on the same answers, by old source", () => {
  const items: SampleItem[] = [
    {
      ...mk(1, "code-review", "llm", 0.9),
      n: 1,
      oldLabel: "design",
      oldBy: "skill",
    },
    {
      ...mk(2, "implement", "llm", 0.9),
      n: 2,
      oldLabel: "implement",
      oldBy: "llm",
    },
  ];
  const s = scoreAnswers(
    items,
    new Map([
      [1, "code-review"],
      [2, "implement"],
    ]),
  );
  expect(s.correct).toBe(2);
  expect(s.oldCorrect).toBe(1);
  expect(s.oldByBy.skill).toEqual({ ok: 0, n: 1 });
  expect(s.newByOldBy.skill).toEqual({ ok: 1, n: 1 });
});

test("compare: agreement by old source, top pairs, pi-config rule agreement", () => {
  const r = (oldLabel: string, oldBy: CompareRow["oldBy"], newLabel: string): CompareRow => ({
    oldLabel,
    oldBy,
    newLabel,
  });
  const c = compareLabels([
    r("design", "skill", "code-review"),
    r("design", "skill", "code-review"),
    r("design", "skill", "design"),
    r("pi-config", "project", "pi-config"),
    r("pi-config", "project", "implement"),
  ]);
  expect(c.bySource.find(([k]) => k === "skill")![1]).toEqual({
    agree: 1,
    n: 3,
  });
  expect(c.topPairs[0]).toEqual(["design → code-review", 2]);
  expect(c.projectRule).toEqual({ n: 2, agree: 1 });
});
