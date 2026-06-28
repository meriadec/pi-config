import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const GRILLADE_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export const GRILLADE_PHASES = ["opening", "questioning", "docs_proposal", "finalizing"] as const;
export const GRILLADE_FINAL_ACTION_IDS = [
  "implement_now",
  "create_epic_issues",
  "create_update_docs",
  "continue_grilling",
  "export_summary",
  "close",
] as const;

export const GrilladeConfidenceSchema = StringEnum(GRILLADE_CONFIDENCE_LEVELS, {
  description: "How confident the assistant is that this option is a good direction.",
});

export const GrilladePhaseSchema = StringEnum(GRILLADE_PHASES, {
  description: "The current semantic phase of the Grillade interview.",
});

export const GrilladeFinalActionIdSchema = StringEnum(GRILLADE_FINAL_ACTION_IDS, {
  description: "Identifier for an action offered on the final Grillade screen.",
});

export const GrilladeQuestionOptionSchema = Type.Object({
  id: Type.String({ description: "Stable option id unique within the question." }),
  title: Type.String({ description: "Short option title shown in the option card." }),
  body: Type.String({ description: "Rationale, tradeoffs, or details for this option." }),
  confidence: GrilladeConfidenceSchema,
  recommended: Type.Boolean({ description: "True for exactly one option in the question." }),
});

export const GrilladeQuestionOptionsSchema = Type.Array(GrilladeQuestionOptionSchema, {
  minItems: 2,
  maxItems: 3,
  description: "Two or three mutually comparable options. Exactly one must be recommended.",
});

export const GrilladeQuestionProgressSchema = Type.Object({
  answered: Type.Integer({ minimum: 0, description: "Number of submitted answers so far." }),
  totalHint: Type.Optional(
    Type.Integer({ minimum: 1, description: "Assistant's current expected total question count." }),
  ),
  maxHint: Type.Optional(
    Type.Integer({ minimum: 1, description: "User-requested or inferred maximum question count." }),
  ),
});

export const GrilladeAskQuestionInputSchema = Type.Object({
  questionId: Type.String({ description: "Stable id for this question." }),
  phase: Type.Optional(GrilladePhaseSchema),
  question: Type.String({ description: "The single question the user should answer now." }),
  context: Type.Optional(
    Type.String({ description: "Optional concise context that helps answer the question." }),
  ),
  constraints: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional process constraints or steering that remain visible with the question.",
    }),
  ),
  options: GrilladeQuestionOptionsSchema,
  allowCustomAnswer: Type.Optional(
    Type.Boolean({
      default: true,
      description: "Whether the UI should allow a custom answer/steering text.",
    }),
  ),
  progress: Type.Optional(GrilladeQuestionProgressSchema),
});

export const GrilladeAnsweredResultSchema = Type.Object({
  status: Type.Literal("answered"),
  questionId: Type.String(),
  selectedOptionId: Type.Optional(
    Type.String({ description: "The selected option id, if the user selected an option." }),
  ),
  customAnswer: Type.Optional(
    Type.String({ description: "Submitted custom answer text, if any." }),
  ),
  steering: Type.Optional(
    Type.String({ description: "Submitted steering or follow-up instruction, if any." }),
  ),
  submittedAt: Type.String({ description: "ISO timestamp for the submitted answer." }),
});

export const GrilladePauseCancelResultSchema = Type.Object({
  status: StringEnum(["paused", "cancelled"] as const),
  questionId: Type.Optional(Type.String()),
  reason: Type.Optional(
    Type.String({ description: "Human-readable reason for UI internals/logging." }),
  ),
  at: Type.String({ description: "ISO timestamp for the pause/cancel event." }),
});

export const GrilladeQuestionResultSchema = Type.Union([
  GrilladeAnsweredResultSchema,
  GrilladePauseCancelResultSchema,
]);

export const GrilladeFinalActionSchema = Type.Object({
  id: GrilladeFinalActionIdSchema,
  label: Type.String({ description: "Human-readable label for the final action menu." }),
  description: Type.Optional(
    Type.String({ description: "Short explanation of what the action will do." }),
  ),
});

export const GrilladeFinishInputSchema = Type.Object({
  summary: Type.String({ description: "Concise summary of the completed Grillade interview." }),
  decisions: Type.Array(Type.String(), {
    description: "Decisions or strong conclusions reached during the interview.",
  }),
  openQuestions: Type.Optional(
    Type.Array(Type.String(), {
      description: "Known unanswered questions, risks, or follow-up topics.",
    }),
  ),
  recommendedNextAction: GrilladeFinalActionIdSchema,
  availableActions: Type.Array(GrilladeFinalActionSchema, {
    minItems: 1,
    description: "Actions the final screen should offer.",
  }),
  docsProposalSummaries: Type.Optional(
    Type.Array(Type.String(), {
      description: "Docs/glossary/ADR opportunities to preserve for handoff.",
    }),
  ),
});

export type GrilladeConfidence = (typeof GRILLADE_CONFIDENCE_LEVELS)[number];
export type GrilladePhase = (typeof GRILLADE_PHASES)[number];
export type GrilladeFinalActionId = (typeof GRILLADE_FINAL_ACTION_IDS)[number];
export type GrilladeQuestionOption = Static<typeof GrilladeQuestionOptionSchema>;
export type GrilladeQuestionOptions =
  | [GrilladeQuestionOption, GrilladeQuestionOption]
  | [GrilladeQuestionOption, GrilladeQuestionOption, GrilladeQuestionOption];
export type GrilladeQuestionProgress = Static<typeof GrilladeQuestionProgressSchema>;
export type GrilladeAskQuestionInput = Omit<
  Static<typeof GrilladeAskQuestionInputSchema>,
  "options"
> & {
  options: GrilladeQuestionOptions;
};
export type GrilladeAnsweredResult = Static<typeof GrilladeAnsweredResultSchema>;
export type GrilladePauseCancelResult = Static<typeof GrilladePauseCancelResultSchema>;
export type GrilladeQuestionResult = GrilladeAnsweredResult | GrilladePauseCancelResult;
export type GrilladeFinalAction = Static<typeof GrilladeFinalActionSchema>;
export type GrilladeFinishInput = Static<typeof GrilladeFinishInputSchema>;

export type NormalizedGrilladeQuestionOption = Omit<GrilladeQuestionOption, "recommended">;
export type NormalizedGrilladeQuestion = Omit<GrilladeAskQuestionInput, "options"> & {
  options: readonly NormalizedGrilladeQuestionOption[];
  recommendedOptionId: string;
};

export function getRecommendedOption(
  question: Pick<GrilladeAskQuestionInput, "options">,
): GrilladeQuestionOption {
  assertValidGrilladeQuestion(question);
  return question.options.find((option) => option.recommended)!;
}

export function normalizeGrilladeQuestion(
  question: GrilladeAskQuestionInput,
): NormalizedGrilladeQuestion {
  const recommended = getRecommendedOption(question);
  return {
    ...question,
    options: question.options.map(({ recommended: _recommended, ...option }) => option),
    recommendedOptionId: recommended.id,
  };
}

export function assertValidGrilladeQuestion(
  question: Pick<GrilladeAskQuestionInput, "options">,
): asserts question is Pick<GrilladeAskQuestionInput, "options"> {
  if (question.options.length < 2 || question.options.length > 3) {
    throw new Error("Grillade questions must have between 2 and 3 options.");
  }

  const optionIds = new Set<string>();
  let recommendedCount = 0;
  for (const option of question.options) {
    if (optionIds.has(option.id)) throw new Error(`Duplicate Grillade option id: ${option.id}`);
    optionIds.add(option.id);
    if (option.recommended) recommendedCount++;
  }

  if (recommendedCount !== 1) {
    throw new Error(
      `Grillade questions must have exactly one recommended option; received ${recommendedCount}.`,
    );
  }
}

export function isGrilladeFinalActionId(value: string): value is GrilladeFinalActionId {
  return (GRILLADE_FINAL_ACTION_IDS as readonly string[]).includes(value);
}
