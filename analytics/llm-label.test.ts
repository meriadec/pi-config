import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, loadCache, parseAnswer, PROMPT_VERSION } from "./llm-label.ts";
import type { SessionRow } from "./sessions.ts";

const row = (file: string, firstText: string): SessionRow => ({
  file,
  firstText,
  firstSkill: null,
  project: "--home-mpillet-x--",
  edits: 1,
  bash: 2,
  reads: 3,
  turns: 9,
  startedAt: "",
  lastText: "",
});

test("the prompt never contains a secret from the first message", () => {
  const p = buildPrompt([row("a", "use T3_MCP_BEARER_TOKEN=abcdefghijklmnop1234 to call it")]);
  expect(p).not.toContain("abcdefghijklmnop1234");
});
test("answers map back to files; unknown labels and bad indexes are dropped", () => {
  const batch = [row("a", "x"), row("b", "y")];
  const got = parseAnswer(
    'sure: [{"i":0,"label":"implement","confidence":0.9},{"i":1,"label":"nonsense","confidence":1},{"i":7,"label":"other","confidence":1}]',
    batch,
  );
  expect(got).toEqual([
    {
      file: "a",
      label: "implement",
      confidence: 0.9,
      model: expect.any(String),
      promptVersion: PROMPT_VERSION,
    },
  ]);
});
test("garbage output gives no labels instead of throwing", () => {
  expect(parseAnswer("I cannot", [row("a", "x")])).toEqual([]);
  expect(parseAnswer("[not json]", [row("a", "x")])).toEqual([]);
});

test("prompt says a skill is only a hint and the user's words decide; skill is given as a feature", () => {
  const p = buildPrompt([
    {
      ...row("a", "please review the current changes"),
      firstSkill: "codebase-design",
    },
  ]);
  expect(p).toMatch(/only a hint/);
  expect(p).toMatch(/user's own words after the skill/);
  expect(p).toContain('"skill":"codebase-design"');
  expect(p).toContain('"firstMessageAfterSkill":"please review the current changes"');
  expect(p).not.toMatch(/"label":"design"/); // the skill's label is a suggestion, not an answer
});
test("last message is sent only when present, and is redacted", () => {
  expect(buildPrompt([row("a", "x")])).not.toContain('"lastMessage"');
  const p = buildPrompt([
    { ...row("a", "x"), lastText: "API_TOKEN=abcdefghijklmnop1234 now review" },
  ]);
  expect(p).toContain('"lastMessage"');
  expect(p).not.toContain("abcdefghijklmnop1234");
});
test("answers record the prompt version", () => {
  expect(
    parseAnswer('[{"i":0,"label":"other","confidence":1}]', [row("a", "x")])[0]!.promptVersion,
  ).toBe(PROMPT_VERSION);
});
test("cache never mixes prompt versions", () => {
  const f = join(mkdtempSync(join(tmpdir(), "lab-")), "c.jsonl");
  const l = (file: string, label: string, v?: string) =>
    JSON.stringify({
      file,
      label,
      confidence: 1,
      model: "m",
      promptVersion: v,
    });
  writeFileSync(
    f,
    [l("a", "design", "old"), l("b", "implement", PROMPT_VERSION), l("c", "other")].join("\n"),
  );
  expect([...loadCache(f).keys()]).toEqual(["b"]);
  expect([...loadCache(f, null).keys()].sort()).toEqual(["a", "b", "c"]);
});
