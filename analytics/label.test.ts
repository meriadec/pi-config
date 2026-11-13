import { expect, test } from "bun:test";
import { labelByRules, originOf, skillHint, type SessionFeatures } from "./label.ts";

const base: SessionFeatures = {
  firstSkill: null,
  firstText: "",
  project: "--home-mpillet-ledger-revault--",
  edits: 0,
  bash: 0,
  reads: 0,
};
const f = (o: Partial<SessionFeatures>) => ({ ...base, ...o });

test("a leading skill decides the label, even over keywords", () => {
  expect(labelByRules(f({ firstSkill: "create-pr", firstText: "there is a conflict" }))).toEqual({
    label: "pr-create",
    by: "skill",
  });
});
test("pi config project is labelled from the folder", () => {
  expect(labelByRules(f({ project: "--home-mpillet-.pi--" })).label).toBe("pi-config");
  expect(labelByRules(f({ project: "--home-mpillet-.pi.feat-home--" })).label).toBe("pi-config");
  expect(labelByRules(f({ project: "--home-mpillet-ledger-pi-tools--" })).label).not.toBe(
    "pi-config",
  );
});
test("keywords label a thread without a skill", () => {
  expect(labelByRules(f({ firstText: "please resolve the merge conflicts" })).label).toBe(
    "conflict-resolution",
  );
});
test("rebase request is history work, not conflict work", () => {
  expect(labelByRules(f({ firstText: "rebase on top of main" })).label).toBe("history-refactor");
});
test("anything else is left for the LLM", () => {
  expect(labelByRules(f({ firstText: "pnpm install is failing", bash: 4, reads: 9 })).by).toBe(
    "unclear",
  );
});
test("machine-written briefs are delegated children; a person's words are human", () => {
  expect(
    originOf({
      firstText: "Act as the implementation sub-agent for this task.",
    }),
  ).toBe("delegated-child");
  expect(originOf({ firstText: "Delegation Job 2026 Task: do x" })).toBe("delegated-child");
  expect(originOf({ firstText: "can you act as a reviewer" })).toBe("human");
});
test("a skill maps to a suggestion only (null for unknown skills)", () => {
  expect(skillHint("codebase-design")).toBe("design");
  expect(skillHint("not-a-skill")).toBeNull();
  expect(skillHint(null)).toBeNull();
});
