import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  aggregate,
  buildRows,
  eventFromRead,
  eventsFromUserContent,
  listSkills,
  oversized,
  topByLoadTokens,
  type SessionStats,
  type SkillEvent,
  type SkillInfo,
} from "./skills-report.ts";

const block = (text: string) => JSON.stringify([{ type: "text", text }]);

test("injected skill is found only at the start of a text block", () => {
  const inj = '<skill name="tdd" location="x">\nbody</skill>';
  const e = eventsFromUserContent("f", "2026-01-01T00:00:00Z", block(inj));
  expect(e).toEqual([
    { file: "f", ts: "2026-01-01T00:00:00Z", skill: "tdd", kind: "inject", bytes: inj.length },
  ]);
  expect(eventsFromUserContent("f", "t", block('see <skill name="tdd" in text'))).toEqual([]);
});

test("raw /skill: command is found", () => {
  const e = eventsFromUserContent("f", "t", block("/skill:grilling plan x"));
  expect(e.map((x) => [x.skill, x.kind])).toEqual([["grilling", "command"]]);
});

test("read of SKILL.md maps to the skill name, other reads do not", () => {
  expect(eventFromRead("f", "t", "/h/.agents/skills/review/SKILL.md")?.skill).toBe("review");
  expect(eventFromRead("f", "t", "/h/review/README.md")).toBeUndefined();
  expect(eventFromRead("f", "t", undefined)).toBeUndefined();
});

const ev = (
  file: string,
  ts: string,
  skill: string,
  kind: SkillEvent["kind"],
  bytes = 0,
): SkillEvent => ({
  file,
  ts,
  skill,
  kind,
  bytes,
});
const st = (
  file: string,
  toolCalls: number,
  toolErrors: number,
  turns: number,
  cost?: number,
): [string, SessionStats] => [file, { file, toolCalls, toolErrors, turns, cost }];

test("aggregate counts sessions once, recent window, error rate and load tokens", () => {
  const events = [
    ev("a", "2026-01-01T00:00:00Z", "x", "inject", 400),
    ev("a", "2026-01-01T00:01:00Z", "x", "read"),
    ev("b", "2026-06-20T00:00:00Z", "x", "inject", 400),
    ev("b", "2026-06-20T00:00:00Z", "y", "command"),
  ];
  const stats = new Map([st("a", 100, 5, 10, 1.5), st("b", 300, 3, 20, 0.5)]);
  const agg = aggregate(events, stats, () => 800, new Date("2026-07-01T00:00:00Z"));
  const x = agg.get("x")!;
  expect(x.sessions).toBe(2);
  expect(x.loads).toBe(3);
  expect(x.first).toBe("2026-01-01T00:00:00Z");
  expect(x.last).toBe("2026-06-20T00:00:00Z");
  expect(x.recent).toBe(1);
  expect(x.toolCalls).toBe(400);
  expect(x.toolErrors).toBe(8);
  expect(x.errorsPer1000).toBeCloseTo(20);
  expect(x.turns).toBe(30);
  expect(x.cost).toBeCloseTo(2);
  expect(x.loadTokens).toBe((400 + 800 + 400) / 4);
  expect(agg.get("y")!.loads).toBe(0);
});

test("rows mark never-used skills and keep history-only skills", () => {
  const infos: SkillInfo[] = [
    { name: "used", symlink: false, skillBytes: 9000, extraBytes: 0, extraFiles: 0 },
    { name: "unused", symlink: true, skillBytes: 10, extraBytes: 0, extraFiles: 0 },
  ];
  const agg = aggregate(
    [
      ev("a", "2026-01-01T00:00:00Z", "used", "inject", 100),
      ev("a", "2026-01-01T00:00:00Z", "gone", "inject", 100),
    ],
    new Map(),
    () => 0,
    new Date(),
  );
  const rs = buildRows(infos, agg);
  expect(rs.map((r) => r.name).sort()).toEqual(["gone", "unused", "used"]);
  expect(rs.find((r) => r.name === "unused")!.agg).toBeUndefined();
  expect(oversized(rs).map((r) => r.name)).toEqual(["used"]);
  expect(topByLoadTokens(rs, 1)).toHaveLength(1);
});

test("listSkills flags a broken symlink and a local skill", () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(dir, "local"));
  writeFileSync(join(dir, "local", "SKILL.md"), "12345");
  writeFileSync(join(dir, "local", "extra.md"), "12");
  symlinkSync(join(dir, "nowhere"), join(dir, "dead"));
  const l = listSkills(dir);
  expect(l.find((i) => i.name === "local")).toMatchObject({
    skillBytes: 5,
    extraBytes: 2,
    extraFiles: 1,
    symlink: false,
  });
  expect(l.find((i) => i.name === "dead")).toMatchObject({ broken: true, symlink: true });
});
