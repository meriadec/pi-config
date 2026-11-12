import { expect, test } from "bun:test";
import { buildPrompt, parseAnswer } from "./llm-label.ts";
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
    { file: "a", label: "implement", confidence: 0.9, model: expect.any(String) },
  ]);
});
test("garbage output gives no labels instead of throwing", () => {
  expect(parseAnswer("I cannot", [row("a", "x")])).toEqual([]);
  expect(parseAnswer("[not json]", [row("a", "x")])).toEqual([]);
});
