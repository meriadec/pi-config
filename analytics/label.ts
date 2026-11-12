/** Thread task taxonomy. Rules first (free, deterministic); an LLM only sees what rules leave as "unclear". */

export const LABELS = [
  "pr-create",
  "pr-review",
  "conflict-resolution",
  "history-refactor",
  "spec-grill",
  "design",
  "planning",
  "code-review",
  "implement",
  "diagnose",
  "infra-ops",
  "pi-config",
  "explore-qa",
  "other",
] as const;
export type Label = (typeof LABELS)[number];

export interface SessionFeatures {
  firstSkill: string | null;
  /** First user message with any leading <skill> block removed. */
  firstText: string;
  /** Session folder name, e.g. --home-mpillet-ledger-revault.feat-x--. */
  project: string;
  edits: number;
  bash: number;
  reads: number;
}

const SKILL_LABEL: Record<string, Label> = {
  "create-pr": "pr-create",
  "pr-review-triage": "pr-review",
  "resolve-conflicts": "conflict-resolution",
  "resolving-merge-conflicts": "conflict-resolution",
  "refine-branch-commits": "history-refactor",
  stack: "history-refactor",
  "stack-and-peel": "history-refactor",
  "extract-refactorings": "history-refactor",
  "grill-with-docs": "spec-grill",
  "grill-me": "spec-grill",
  grilling: "spec-grill",
  wayfinder: "spec-grill",
  "decision-mapping": "spec-grill",
  "codebase-design": "design",
  "design-an-interface": "design",
  "improve-codebase-architecture": "design",
  triage: "planning",
  "to-issues": "planning",
  "to-prd": "planning",
  "to-spec": "planning",
  "to-tickets": "planning",
  "code-review": "code-review",
  review: "code-review",
  implement: "implement",
  "implement-spec": "implement",
  tdd: "implement",
  diagnose: "diagnose",
  "diagnosing-bugs": "diagnose",
  "vault-env": "infra-ops",
  bake: "infra-ops",
  "manage-docker-images": "infra-ops",
};

export type Origin = "human" | "delegated-child";

/** Delegated children start from a machine-written brief, not from a person's words. */
export function originOf(f: Pick<SessionFeatures, "firstText">): Origin {
  return /^(act as the .{0,60}sub-?agent|(sub-agent )?delegation (job|result)|you work in a (fresh )?git (worktree|checkout))/i.test(
    f.firstText.trimStart(),
  )
    ? "delegated-child"
    : "human";
}

export type Labelled =
  | { label: Label; by: "skill" | "project" | "keyword" }
  | { label: null; by: "unclear" };

export function labelByRules(f: SessionFeatures): Labelled {
  if (f.firstSkill && SKILL_LABEL[f.firstSkill])
    return { label: SKILL_LABEL[f.firstSkill]!, by: "skill" };
  if (/--home-mpillet-\.pi(-agent[^.]*)?(\.|--)/.test(f.project))
    return { label: "pi-config", by: "project" };
  const t = f.firstText.toLowerCase();
  if (/\bconflicts?\b/.test(t)) return { label: "conflict-resolution", by: "keyword" };
  if (/^rebase\b/.test(t)) return { label: "history-refactor", by: "keyword" };
  if (/\b(create|open|make) (a |the )?(pr|pull request)\b/.test(t))
    return { label: "pr-create", by: "keyword" };
  if (/\b(review comments?|copilot review|pr feedback)\b/.test(t))
    return { label: "pr-review", by: "keyword" };
  if (/\b(deploy|argocd|kubectl|docker image|pod)\b/.test(t))
    return { label: "infra-ops", by: "keyword" };
  return { label: null, by: "unclear" };
}
