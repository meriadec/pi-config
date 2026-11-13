import { expect, test } from "bun:test";
import type { MessageUsage } from "./cost.ts";
import type { ModelSessionInput } from "./models.ts";
import { parseSince, parseStart } from "./report.ts";
import {
  DAY_MS,
  MAX_SECTION_LINES,
  NEW_LABEL_CAP,
  concentrationSection,
  contextSection,
  errorsSection,
  modelsSection,
  movers,
  pollingSection,
  renderWeekly,
  resolveLabels,
  spendOf,
  spendSection,
  split,
  windowsFrom,
  type WeeklySession,
} from "./weekly.ts";

const W0 = Date.parse("2026-03-09T00:00:00Z");
const w = windowsFrom(W0);
const msg = (model: string, over: Partial<MessageUsage> = {}): MessageUsage => ({
  file: "f",
  model,
  input: 1_000_000,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  notional: 0,
  ...over,
});
const sess = (
  file: string,
  startedMs: number,
  label: string,
  usage: MessageUsage[],
  extra: Partial<WeeklySession> = {},
): WeeklySession => ({
  file,
  startedMs,
  label,
  usage,
  toolingErrors: {},
  bashCommands: [],
  ...extra,
});
const lines = (s: string[]) => s.length;

test("window: week starts at --since, previous is the 4 weeks before; ends are exclusive", () => {
  const all = [
    sess("before", w.prevStart - 1, "a", []),
    sess("prevStart", w.prevStart, "a", []),
    sess("prevLast", W0 - 1, "a", []),
    sess("weekStart", W0, "a", []),
    sess("weekLast", w.weekEnd - 1, "a", []),
    sess("after", w.weekEnd, "a", []),
  ];
  const { week, prev } = split(all, w);
  expect(week.map((s) => s.file)).toEqual(["weekStart", "weekLast"]);
  expect(prev.map((s) => s.file)).toEqual(["prevStart", "prevLast"]);
  expect(W0 - w.prevStart).toBe(28 * DAY_MS);
});

test("--since parsing and UTC session start", () => {
  expect(parseSince(["--since", "2026-03-09"])).toBe(W0);
  expect(() => parseSince(["--since", "03/09"])).toThrow();
  expect(parseStart("2026-03-09 00:00:00")).toBe(W0);
});

test("labelling: cache first, rules for new sessions, hard cap with a clear line", () => {
  const mk = (i: number) => ({
    file: `s${i}`,
    project: "p",
    firstSkill: null,
    firstText: "please resolve the conflicts",
    edits: 0,
    bash: 0,
    reads: 0,
  });
  const sessions = Array.from({ length: NEW_LABEL_CAP + 5 }, (_, i) => mk(i));
  const r = resolveLabels(
    sessions,
    new Map([["s0", { label: "implement" }]]),
    new Map(),
    NEW_LABEL_CAP,
  );
  expect(r.labelOf.get("s0")).toBe("implement");
  expect(r.added.length).toBe(NEW_LABEL_CAP);
  expect(r.added.some((a) => a.file === "s0")).toBe(false);
  expect(r.left).toBe(4);
  expect(r.labelOf.get("s304")).toBe("UNLABELLED");
  expect(r.labelOf.get("s1")).toBe("conflict-resolution");
  expect(r.line).toContain("4 sessions left unlabelled");
  const again = resolveLabels(sessions, new Map(), new Map(r.added.map((a) => [a.file, a])), 10);
  // second run: only s0 and the 4 left over are new
  expect(again.added.map((a) => a.file)).toEqual(["s0", "s301", "s302", "s303", "s304"]);
  expect(again.left).toBe(0);
});

test("spend: grouped by label and model; unpriced model marked, never counted as $0 cost", () => {
  const week = spendOf([
    sess("a", W0, "implement", [msg("claude-opus-4-5")]),
    sess("b", W0, "diagnose", [msg("claude-opus-4-5"), msg("mystery-model-9", { input: 777 })]),
  ]);
  expect(week.byLabel.get("implement")).toBeGreaterThan(0);
  expect(week.byLabel.get("diagnose")).toBeGreaterThan(0);
  expect(week.byModel.has("mystery-model-9")).toBe(false);
  expect(week.unpricedByModel.get("mystery-model-9")).toBe(777);
  const out = spendSection(week, spendOf([])).join("\n");
  expect(out).toContain("mystery-model-9: unpriced (777 tokens");
  expect(out).toContain("- implement:");
  expect(out).toContain("+ 777 unpriced tokens");
  expect(lines(spendSection(week, spendOf([])))).toBeLessThanOrEqual(MAX_SECTION_LINES);
});

test("concentration: top 5% share and top 3 paths", () => {
  const xs = Array.from({ length: 20 }, (_, i) =>
    sess(`/p/${i}.jsonl`, W0, "x", [
      msg("claude-opus-4-5", { input: i === 7 ? 9_000_000 : 1_000_000 }),
    ]),
  );
  const s = spendOf(xs);
  const out = concentrationSection(s, spendOf([]), new Map()).join("\n");
  expect(out).toContain("Top 5% (1 of 20 sessions)");
  expect(out).toMatch(/hold 32%/);
  expect(out.indexOf("/p/7.jsonl")).toBeGreaterThan(0);
  expect(out.match(/\/p\/\d+\.jsonl/g)?.length).toBe(3);
});

test("context: counts sessions above 150K and 300K and prices only the part above 150K", () => {
  const big = (n: number) => msg("claude-opus-4-5", { input: 0, cacheRead: n });
  const week = [
    sess("a", W0, "x", [big(200_000)]),
    sess("b", W0, "x", [big(400_000)]),
    sess("c", W0, "x", [big(100_000)]),
  ];
  const out = contextSection(week, []).join("\n");
  expect(out).toContain("above 150K: 2 of 3");
  expect(out).toContain("above 300K: 1 of 3");
  // opus cache read price per token x (50K + 250K) tokens
  const perTok = 0.5 / 1e6;
  expect(out).toContain(`$${(300_000 * perTok).toFixed(2)}`);
});

test("errors: top 5 classes with change against the prev 4 weeks average", () => {
  const week = [
    sess("a", W0, "x", [], {
      toolingErrors: { "edit-bad-anchor": 8, "path-not-found": 1, a1: 1, a2: 1, a3: 1, a4: 1 },
    }),
  ];
  const prev = [sess("p", W0 - DAY_MS, "x", [], { toolingErrors: { "edit-bad-anchor": 16 } })];
  const out = errorsSection(week, prev);
  expect(out[1]).toBe("- edit-bad-anchor: 8 (prev 4.0/wk, +100%)");
  expect(out.length).toBe(1 + 5);
});

test("polling: sleep commands and loops counted from this week only", () => {
  const week = [
    sess("a", W0, "x", [], { bashCommands: ["while true; do gh pr view 1; sleep 30; done", "ls"] }),
  ];
  const prev = [sess("p", W0 - DAY_MS, "x", [], { bashCommands: ["sleep 600", "sleep 600"] })];
  const out = pollingSection(week, prev).join("\n");
  expect(out).toContain("1 in 1 sessions (prev 0.5/wk)");
});

test("models: cells under 15 sessions say 'too few'", () => {
  const mk = (i: number, label: string): ModelSessionInput => ({
    file: `${label}${i}`,
    label,
    usage: [msg("claude-opus-4-5")],
    timestamps: [W0, W0 + 1000],
    toolResults: 0,
    toolErrors: 0,
    aborts: 0,
    stopErrors: 0,
    userMessages: 1,
    lastUsers: [],
  });
  const inputs = [
    ...Array.from({ length: 15 }, (_, i) => mk(i, "implement")),
    ...Array.from({ length: 14 }, (_, i) => mk(i, "diagnose")),
  ];
  const out = modelsSection(inputs).join("\n");
  expect(out).toMatch(/- implement: claude-opus-4-5 15 sessions/);
  expect(out).toMatch(/- diagnose: too few/);
});

test("movers: 3 largest relative movers above the floor", () => {
  const week = [sess("a", W0, "implement", [msg("claude-opus-4-5", { input: 10_000_000 })])];
  const prev = [
    sess("p", W0 - DAY_MS, "implement", [msg("claude-opus-4-5", { input: 1_000_000 })]),
  ];
  const ms = movers(spendOf(week), spendOf(prev), week, prev);
  expect(ms.length).toBeGreaterThan(0);
  expect(ms.length).toBeLessThanOrEqual(3);
  expect(ms[0]!.week).toBeGreaterThan(ms[0]!.prev);
});

test("renderWeekly: summary line first, every section within 12 lines, previous sessions excluded from week total", () => {
  const sessions = [
    sess("a", W0, "implement", [msg("claude-opus-4-5")]),
    sess("old", W0 - DAY_MS, "implement", [msg("claude-opus-4-5", { input: 50_000_000 })]),
  ];
  const out = renderWeekly({
    date: "2026-03-16",
    windows: w,
    sessions,
    paths: new Map(),
    modelInputs: [],
    labelLine: "Labels: ok",
  });
  const l = out.split("\n");
  expect(l[1]).toMatch(/^Week 2026-03-09\.\.2026-03-15: \$5\.00, 1 sessions, biggest mover:/);
  const secs = out.split(/^## /m).slice(1);
  expect(secs.length).toBe(7);
  for (const s of secs) expect(s.trim().split("\n").length).toBeLessThanOrEqual(MAX_SECTION_LINES);
});
