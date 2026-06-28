import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  GrilladeAnsweredResult,
  GrilladeAskQuestionInput,
  GrilladeFinalActionId,
  GrilladeFinishInput,
  GrilladePhase,
  GrilladePauseCancelResult,
  NormalizedGrilladeQuestion,
} from "./protocol.ts";
import { normalizeGrilladeQuestion } from "./protocol.ts";

export const GRILLADE_STATE_CUSTOM_TYPE = "grillade-state";
export const GRILLADE_STATE_VERSION = 1;

export type GrilladeStatus = "active" | "paused" | "finished";
export type GrilladeDocsProposalStatus = "proposed" | "accepted" | "skipped" | "applied";

export type GrilladeSessionMetadata = {
  grilladeId: string;
  prompt: string;
  docsMode: boolean;
  startedAt: string;
  cwd?: string;
  sessionId?: string;
  maxQuestionsHint?: number;
};

export type ActiveGrilladeQuestion = NormalizedGrilladeQuestion & {
  askedAt: string;
};

export type GrilladeAnswerRecord = {
  questionId: string;
  question: string;
  phase?: GrilladePhase;
  selectedOptionId?: string;
  customAnswer?: string;
  steering?: string;
  submittedAt: string;
};

export type GrilladeDocsProposalSummary = {
  id: string;
  title: string;
  summary: string;
  status: GrilladeDocsProposalStatus;
  updatedAt: string;
};

export type GrilladeFinalResult = GrilladeFinishInput & {
  finishedAt: string;
  selectedAction?: GrilladeFinalActionId;
  selectedActionSteering?: string;
  selectedActionAt?: string;
};

export type GrilladeTimestamps = {
  createdAt: string;
  updatedAt: string;
  pausedAt?: string;
  finishedAt?: string;
};

export type SemanticGrilladeState = {
  version: typeof GRILLADE_STATE_VERSION;
  metadata: GrilladeSessionMetadata;
  status: GrilladeStatus;
  currentPhase: GrilladePhase;
  activeQuestion?: ActiveGrilladeQuestion;
  answerHistory: GrilladeAnswerRecord[];
  docsProposals: GrilladeDocsProposalSummary[];
  finalResult?: GrilladeFinalResult;
  timestamps: GrilladeTimestamps;
};

export type GrilladeStartTransition = {
  type: "started";
  metadata: GrilladeSessionMetadata;
  phase?: GrilladePhase;
  at: string;
};

export type GrilladeQuestionAskedTransition = {
  type: "question_asked";
  question: GrilladeAskQuestionInput;
  askedAt: string;
};

export type GrilladeAnswerSubmittedTransition = {
  type: "answer_submitted";
  result: GrilladeAnsweredResult;
};

export type GrilladePausedTransition = {
  type: "paused";
  result?: GrilladePauseCancelResult;
  at: string;
};

export type GrilladeResumedTransition = {
  type: "resumed";
  at: string;
};

export type GrilladeDocsProposalUpdatedTransition = {
  type: "docs_proposal_updated";
  proposal: GrilladeDocsProposalSummary;
};

export type GrilladeFinishedTransition = {
  type: "finished";
  result: GrilladeFinishInput;
  finishedAt: string;
};

export type GrilladeFinalActionSelectedTransition = {
  type: "final_action_selected";
  actionId: GrilladeFinalActionId;
  steering?: string;
  at: string;
};

export type GrilladeStateTransition =
  | GrilladeStartTransition
  | GrilladeQuestionAskedTransition
  | GrilladeAnswerSubmittedTransition
  | GrilladePausedTransition
  | GrilladeResumedTransition
  | GrilladeDocsProposalUpdatedTransition
  | GrilladeFinishedTransition
  | GrilladeFinalActionSelectedTransition;

export type GrilladeStateEntry =
  | {
      entryVersion: typeof GRILLADE_STATE_VERSION;
      kind: "snapshot";
      state: SemanticGrilladeState;
      recordedAt: string;
    }
  | {
      entryVersion: typeof GRILLADE_STATE_VERSION;
      kind: "transition";
      transition: GrilladeStateTransition;
      recordedAt: string;
    };

export type GrilladeStartOptions = {
  grilladeId: string;
  prompt: string;
  docsMode: boolean;
  at?: string;
  cwd?: string;
  sessionId?: string;
  maxQuestionsHint?: number;
  phase?: GrilladePhase;
};

export function initialGrilladeState(options: GrilladeStartOptions): SemanticGrilladeState {
  const at = options.at ?? new Date().toISOString();
  const metadata: GrilladeSessionMetadata = {
    grilladeId: options.grilladeId,
    prompt: options.prompt,
    docsMode: options.docsMode,
    startedAt: at,
  };
  if (options.cwd !== undefined) metadata.cwd = options.cwd;
  if (options.sessionId !== undefined) metadata.sessionId = options.sessionId;
  if (options.maxQuestionsHint !== undefined) metadata.maxQuestionsHint = options.maxQuestionsHint;

  return {
    version: GRILLADE_STATE_VERSION,
    metadata,
    status: "active",
    currentPhase: options.phase ?? "opening",
    answerHistory: [],
    docsProposals: [],
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
  };
}

export type GrilladeBranchSource = {
  getBranch(): SessionEntry[];
};

export function reconstructGrilladeState(
  sessionManager: GrilladeBranchSource,
): SemanticGrilladeState | undefined {
  return reconstructGrilladeStateFromBranch(sessionManager.getBranch());
}

export function reconstructGrilladeStateFromBranch(
  branchEntries: readonly SessionEntry[],
): SemanticGrilladeState | undefined {
  let state: SemanticGrilladeState | undefined;
  for (const entry of branchEntries) {
    const grilladeEntry = getGrilladeStateEntry(entry);
    if (!grilladeEntry) continue;
    if (grilladeEntry.kind === "snapshot") {
      state = cloneState(grilladeEntry.state);
    } else {
      state = applyGrilladeTransition(state, grilladeEntry.transition);
    }
  }
  return state;
}

export function appendGrilladeStateSnapshot(
  pi: Pick<ExtensionAPI, "appendEntry">,
  state: SemanticGrilladeState,
  recordedAt = new Date().toISOString(),
): void {
  pi.appendEntry<GrilladeStateEntry>(GRILLADE_STATE_CUSTOM_TYPE, {
    entryVersion: GRILLADE_STATE_VERSION,
    kind: "snapshot",
    state: cloneState(state),
    recordedAt,
  });
}

export function appendGrilladeTransition(
  pi: Pick<ExtensionAPI, "appendEntry">,
  transition: GrilladeStateTransition,
  recordedAt = new Date().toISOString(),
): void {
  pi.appendEntry<GrilladeStateEntry>(GRILLADE_STATE_CUSTOM_TYPE, {
    entryVersion: GRILLADE_STATE_VERSION,
    kind: "transition",
    transition,
    recordedAt,
  });
}

export function appendGrilladeStart(
  pi: Pick<ExtensionAPI, "appendEntry">,
  options: GrilladeStartOptions,
): void {
  const at = options.at ?? new Date().toISOString();
  const transition: GrilladeStartTransition = {
    type: "started",
    metadata: initialGrilladeState({ ...options, at }).metadata,
    at,
  };
  if (options.phase !== undefined) transition.phase = options.phase;
  appendGrilladeTransition(pi, transition, at);
}

export function appendGrilladeQuestionAsked(
  pi: Pick<ExtensionAPI, "appendEntry">,
  question: GrilladeAskQuestionInput,
  askedAt = new Date().toISOString(),
): void {
  appendGrilladeTransition(pi, { type: "question_asked", question, askedAt }, askedAt);
}

export function appendGrilladeAnswerSubmitted(
  pi: Pick<ExtensionAPI, "appendEntry">,
  result: GrilladeAnsweredResult,
): void {
  appendGrilladeTransition(pi, { type: "answer_submitted", result }, result.submittedAt);
}

export function appendGrilladePaused(
  pi: Pick<ExtensionAPI, "appendEntry">,
  at = new Date().toISOString(),
  result?: GrilladePauseCancelResult,
): void {
  const transition: GrilladePausedTransition = { type: "paused", at };
  if (result !== undefined) transition.result = result;
  appendGrilladeTransition(pi, transition, at);
}

export function appendGrilladeResumed(
  pi: Pick<ExtensionAPI, "appendEntry">,
  at = new Date().toISOString(),
): void {
  appendGrilladeTransition(pi, { type: "resumed", at }, at);
}

export function appendGrilladeDocsProposalUpdated(
  pi: Pick<ExtensionAPI, "appendEntry">,
  proposal: GrilladeDocsProposalSummary,
): void {
  appendGrilladeTransition(pi, { type: "docs_proposal_updated", proposal }, proposal.updatedAt);
}

export function appendGrilladeFinished(
  pi: Pick<ExtensionAPI, "appendEntry">,
  result: GrilladeFinishInput,
  finishedAt = new Date().toISOString(),
): void {
  appendGrilladeTransition(pi, { type: "finished", result, finishedAt }, finishedAt);
}

export function appendGrilladeFinalActionSelected(
  pi: Pick<ExtensionAPI, "appendEntry">,
  actionId: GrilladeFinalActionId,
  at = new Date().toISOString(),
  steering?: string,
): void {
  const transition: GrilladeFinalActionSelectedTransition = {
    type: "final_action_selected",
    actionId,
    at,
  };
  if (steering !== undefined) transition.steering = steering;
  appendGrilladeTransition(pi, transition, at);
}

export function applyGrilladeTransition(
  previous: SemanticGrilladeState | undefined,
  transition: GrilladeStateTransition,
): SemanticGrilladeState | undefined {
  switch (transition.type) {
    case "started": {
      const options: GrilladeStartOptions = {
        grilladeId: transition.metadata.grilladeId,
        prompt: transition.metadata.prompt,
        docsMode: transition.metadata.docsMode,
        at: transition.at,
      };
      if (transition.metadata.cwd !== undefined) options.cwd = transition.metadata.cwd;
      if (transition.metadata.sessionId !== undefined)
        options.sessionId = transition.metadata.sessionId;
      if (transition.metadata.maxQuestionsHint !== undefined)
        options.maxQuestionsHint = transition.metadata.maxQuestionsHint;
      if (transition.phase !== undefined) options.phase = transition.phase;
      return initialGrilladeState(options);
    }
    case "question_asked": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      next.status = "active";
      next.currentPhase = transition.question.phase ?? next.currentPhase;
      next.activeQuestion = {
        ...normalizeGrilladeQuestion(transition.question),
        askedAt: transition.askedAt,
      };
      clearFinishedFields(next);
      markUpdated(next, transition.askedAt);
      return next;
    }
    case "answer_submitted": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      const activeQuestion = next.activeQuestion;
      const answer: GrilladeAnswerRecord = {
        questionId: transition.result.questionId,
        question: activeQuestion?.question ?? "",
        submittedAt: transition.result.submittedAt,
      };
      if (activeQuestion?.phase !== undefined) answer.phase = activeQuestion.phase;
      if (transition.result.selectedOptionId !== undefined)
        answer.selectedOptionId = transition.result.selectedOptionId;
      if (transition.result.customAnswer !== undefined)
        answer.customAnswer = transition.result.customAnswer;
      if (transition.result.steering !== undefined) answer.steering = transition.result.steering;
      next.answerHistory.push(answer);
      if (activeQuestion?.questionId === transition.result.questionId) delete next.activeQuestion;
      next.status = "active";
      markUpdated(next, transition.result.submittedAt);
      return next;
    }
    case "paused": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      next.status = "paused";
      next.timestamps.pausedAt = transition.at;
      markUpdated(next, transition.at);
      return next;
    }
    case "resumed": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      next.status = "active";
      delete next.timestamps.pausedAt;
      markUpdated(next, transition.at);
      return next;
    }
    case "docs_proposal_updated": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      const index = next.docsProposals.findIndex(
        (proposal) => proposal.id === transition.proposal.id,
      );
      if (index >= 0) next.docsProposals[index] = transition.proposal;
      else next.docsProposals.push(transition.proposal);
      markUpdated(next, transition.proposal.updatedAt);
      return next;
    }
    case "finished": {
      if (!previous) return undefined;
      const next = cloneState(previous);
      next.status = "finished";
      next.currentPhase = "finalizing";
      delete next.activeQuestion;
      next.finalResult = { ...transition.result, finishedAt: transition.finishedAt };
      next.timestamps.finishedAt = transition.finishedAt;
      markUpdated(next, transition.finishedAt);
      return next;
    }
    case "final_action_selected": {
      if (!previous?.finalResult) return previous;
      const next = cloneState(previous);
      const finalResult = next.finalResult;
      if (!finalResult) return next;
      finalResult.selectedAction = transition.actionId;
      finalResult.selectedActionAt = transition.at;
      if (transition.steering !== undefined)
        finalResult.selectedActionSteering = transition.steering;
      else delete finalResult.selectedActionSteering;
      markUpdated(next, transition.at);
      return next;
    }
  }
}

function getGrilladeStateEntry(entry: SessionEntry): GrilladeStateEntry | undefined {
  if (entry.type !== "custom" || entry.customType !== GRILLADE_STATE_CUSTOM_TYPE) return undefined;
  return isGrilladeStateEntry(entry.data) ? entry.data : undefined;
}

function isGrilladeStateEntry(value: unknown): value is GrilladeStateEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record["entryVersion"] === GRILLADE_STATE_VERSION &&
    (record["kind"] === "snapshot" || record["kind"] === "transition")
  );
}

function markUpdated(state: SemanticGrilladeState, at: string): void {
  state.timestamps.updatedAt = at;
}

function clearFinishedFields(state: SemanticGrilladeState): void {
  delete state.finalResult;
  delete state.timestamps.finishedAt;
}

function cloneState(state: SemanticGrilladeState): SemanticGrilladeState {
  return structuredClone(state);
}
