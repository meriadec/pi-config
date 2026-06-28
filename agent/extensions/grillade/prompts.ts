import type { GrilladeAnsweredResult } from "./protocol.ts";
import type { SemanticGrilladeState } from "./state.ts";

export type GrilladePromptMode = "kickoff" | "resume" | "continuation";

export type GrilladeKickoffPromptOptions = {
  prompt: string;
  docsMode: boolean;
};

const CORE_INTERVIEW_RULES = [
  "Run Grillade as a structured design interview, not as normal freeform chat.",
  "For every user-facing interview turn, call the `grillade_ask_question` tool instead of writing the question in markdown.",
  "Ask exactly one focused question at a time, then wait for the tool result before continuing.",
  "Each Grillade Question must provide 2–5 options.",
  "Exactly one option must be marked recommended.",
  "Every option must include a short title, a body/rationale, and a confidence level.",
  "Always allow a custom answer and steering; treat steering as binding unless it conflicts with safety or the user's explicit goal.",
  "Honor process steering such as `max 10 questions`, `wrap up if no major unknowns`, `explore this more`, or similar constraints.",
  "When major design branches and dependencies are resolved, finish by calling `grillade_finish`; do not write a final Grillade summary as freeform prose.",
  "Use `grillade_finish` as the only structured final UI path. Include summary, decisions, open questions/risks, recommended next action, and all standard final actions.",
  "If the question tool returns `paused` or `cancelled`, stop immediately; do not continue the interview in prose.",
];

const DOCS_MODE_RULES = [
  "Docs mode is enabled: apply domain-modeling discipline by default.",
  "Read and respect loaded repository context/domain docs where appropriate; if the interview depends on durable vocabulary or existing conventions, consult files such as CONTEXT.md or docs/ before deciding.",
  "Name important domain concepts precisely, challenge fuzzy or conflicting terminology, and prefer the repository's established ubiquitous language unless the user intentionally changes it.",
  "Identify glossary, CONTEXT.md, ADR, or other documentation opportunities when they materially affect the design or preserve an important decision.",
  "Do not over-index on docs: ask design questions first, and introduce docs/domain-modeling implications when they help the user decide.",
  "Do not silently write glossary, ADR, CONTEXT.md, or other docs files from inside the Grillade question UI; docs-aware interviewing is not direct file mutation.",
  "Until inline docs proposal UI exists, preserve docs opportunities in `docsProposalSummaries` and prefer an explicit final handoff through the `create_update_docs` action.",
];

const NO_DOCS_MODE_RULES = [
  "Docs mode is disabled with --no-docs.",
  "Do not perform docs/domain-modeling-specific behavior, read docs solely for domain-modeling, challenge terminology as a docs exercise, or propose glossary/ADR work unless the user explicitly asks for it later.",
  "Keep questions focused on the requested design or implementation decision.",
];

export function buildKickoffPrompt(options: GrilladeKickoffPromptOptions): string {
  return [
    "Start a Grillade interview for the following prompt.",
    "",
    formatManagedInstructions(options.docsMode, "kickoff"),
    "",
    "User prompt:",
    options.prompt,
  ].join("\n");
}

export function buildResumePrompt(
  state: SemanticGrilladeState,
  answer?: GrilladeAnsweredResult,
): string {
  const lines = [
    "Resume this Grillade interview from the persisted Semantic Grillade State.",
    "",
    formatManagedInstructions(state.metadata.docsMode, "resume"),
    "",
    `Original prompt: ${state.metadata.prompt}`,
    `Current phase: ${state.currentPhase}`,
    `Submitted answers so far: ${state.answerHistory.length}`,
  ];

  if (answer) {
    lines.push(
      "",
      "The user just answered the reopened active question:",
      JSON.stringify(answer, null, 2),
    );
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
    "Continue this Grillade interview after the user's submitted answer.",
    "",
    formatManagedInstructions(state.metadata.docsMode, "continuation"),
    "",
    `Original prompt: ${state.metadata.prompt}`,
    `Current phase: ${state.currentPhase}`,
    `Submitted answers before this answer: ${state.answerHistory.length}`,
    "",
    "Submitted answer:",
    JSON.stringify(answer, null, 2),
    "",
    "Use the answer and any steering text to decide whether to ask the next Grillade Question or wrap up when there are no major unknowns.",
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
