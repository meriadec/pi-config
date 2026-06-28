import type { GrilladeAnsweredResult } from "./protocol.ts";
import type { SemanticGrilladeState } from "./state.ts";

export type GrilladePromptMode = "kickoff" | "resume" | "continuation";

export type GrilladeKickoffPromptOptions = {
  prompt: string;
  docsMode: boolean;
};

const CORE_INTERVIEW_RULES = [
  "Use `grillade_ask_question` for every user-facing interview turn; ask exactly one question, wait for the result, then continue.",
  "Each question has 2–3 authored options, exactly one recommended option, and custom answer enabled unless explicitly disabled.",
  "Honor steering such as max question counts, wrap-up requests, and requests to explore more.",
  "When the major branches are resolved, call `grillade_finish` with summary, decisions, risks/open questions, recommended next action, and standard final actions.",
  "If a Grillade tool returns paused/cancelled, stop immediately and do not continue in prose.",
];

const DOCS_MODE_RULES = [
  "Docs mode: use domain-modeling discipline where useful; consult repo context/docs when they affect decisions.",
  "Challenge fuzzy or conflicting domain terms, but do not write docs directly inside Grillade.",
  "Preserve meaningful glossary/ADR/docs opportunities in `docsProposalSummaries` and prefer `create_update_docs` for handoff.",
];

const NO_DOCS_MODE_RULES = [
  "Docs mode is disabled: avoid docs/domain-modeling work unless explicitly requested.",
];

export function buildKickoffPrompt(options: GrilladeKickoffPromptOptions): string {
  return [
    `Start a Grillade interview (${options.docsMode ? "docs" : "no-docs"} mode).`,
    "User prompt:",
    options.prompt,
  ].join("\n");
}

export function buildResumePrompt(
  state: SemanticGrilladeState,
  answer?: GrilladeAnsweredResult,
): string {
  const lines = [
    "Resume the active Grillade interview using the Active Grillade protocol.",
    `Original prompt: ${state.metadata.prompt}`,
    `Phase: ${state.currentPhase}`,
    `Answers: ${state.answerHistory.length}`,
  ];

  if (answer) {
    lines.push("", "User answered reopened question:", JSON.stringify(answer));
  } else if (state.activeQuestion) {
    lines.push(
      "",
      "There is an unanswered active question in the UI. Do not ask a different question until that question has been answered or cancelled.",
    );
  } else {
    lines.push("", "Continue with the next best Grillade Question using `grillade_ask_question`.");
  }

  return lines.join("\n");
}

export function buildContinuationPrompt(
  state: SemanticGrilladeState,
  answer: GrilladeAnsweredResult,
): string {
  return [
    "Continue this Grillade interview using the Active Grillade protocol.",
    `Original prompt: ${state.metadata.prompt}`,
    `Phase: ${state.currentPhase}`,
    `Answers before this: ${state.answerHistory.length}`,
    "Submitted answer:",
    JSON.stringify(answer),
  ].join("\n");
}

export function buildGrilladeSystemPromptAppendix(state: SemanticGrilladeState): string {
  return [
    "",
    "# Active Grillade protocol",
    formatManagedInstructions(state.metadata.docsMode, "continuation"),
    "",
    `Original Grillade prompt: ${state.metadata.prompt}`,
    `Current Grillade phase: ${state.currentPhase}`,
    `Submitted Grillade answers: ${state.answerHistory.length}`,
    state.activeQuestion
      ? `There is an active unanswered Grillade Question (${state.activeQuestion.questionId}). Do not proceed except through that question.`
      : "No active unanswered Grillade Question is currently persisted.",
  ].join("\n");
}

function formatManagedInstructions(docsMode: boolean, mode: GrilladePromptMode): string {
  const modeRule =
    mode === "kickoff"
      ? "Begin by asking the single highest-leverage Grillade Question."
      : "Continue from the latest state; do not restart or repeat already-settled ground unless the user steers you there.";
  const rules = [
    ...CORE_INTERVIEW_RULES,
    modeRule,
    ...(docsMode ? DOCS_MODE_RULES : NO_DOCS_MODE_RULES),
  ];
  return ["Managed Grillade instructions:", ...rules.map((rule) => `- ${rule}`)].join("\n");
}
