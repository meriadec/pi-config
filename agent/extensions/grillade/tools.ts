import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildNormalPiHandoffPrompt, isNormalPiHandoffAction } from "./handoff.ts";
import {
  GrilladeAskQuestionInputSchema,
  GrilladeFinishInputSchema,
  normalizeGrilladeQuestion,
  type GrilladeAskQuestionInput,
  type GrilladeFinalActionId,
  type GrilladeFinishInput,
  type GrilladeQuestionResult,
} from "./protocol.ts";
import {
  appendGrilladeAnswerSubmitted,
  appendGrilladeDocsProposalUpdated,
  appendGrilladeFinalActionSelected,
  appendGrilladeFinished,
  appendGrilladePaused,
  appendGrilladeQuestionAsked,
  appendGrilladeResumed,
  reconstructGrilladeState,
} from "./state.ts";
import { formatGrilladeFinalMarkdown, showGrilladeFinalScreenInUi } from "./ui/final.ts";
import { askGrilladeQuestionInUi } from "./ui/question.ts";

export const GRILLADE_ASK_QUESTION_TOOL_NAME = "grillade_ask_question";
export const GRILLADE_FINISH_TOOL_NAME = "grillade_finish";

export function setGrilladeToolsActive(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  active: boolean,
): void {
  const tools = new Set(pi.getActiveTools());
  const before = tools.size;
  if (active) {
    tools.add(GRILLADE_ASK_QUESTION_TOOL_NAME);
    tools.add(GRILLADE_FINISH_TOOL_NAME);
  } else {
    tools.delete(GRILLADE_ASK_QUESTION_TOOL_NAME);
    tools.delete(GRILLADE_FINISH_TOOL_NAME);
  }
  if (tools.size !== before || active !== tools.has(GRILLADE_ASK_QUESTION_TOOL_NAME)) {
    pi.setActiveTools([...tools]);
  }
}

export function registerGrilladeTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: GRILLADE_ASK_QUESTION_TOOL_NAME,
    label: "Grillade Question",
    description:
      "Ask one structured Grillade interview question and block until the user submits an answer or closes/cancels the question UI.",
    promptSnippet: "Ask a structured Grillade interview question with 2–3 options",
    promptGuidelines: [
      "In active Grillade sessions, ask through grillade_ask_question: one question, 2–3 authored options, exactly one recommended, custom answer allowed.",
      "Wait for each tool result, honor steering, and stop if the result is paused/cancelled.",
    ],
    parameters: GrilladeAskQuestionInputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = reconstructGrilladeState(ctx.sessionManager);
      if (!state || state.status === "finished") {
        const result: GrilladeQuestionResult = {
          status: "cancelled",
          reason: "No active Grillade session is available for this question.",
          at: new Date().toISOString(),
        };
        return formatQuestionToolResult(result, true);
      }

      const askedAt = new Date().toISOString();
      const question = params as GrilladeAskQuestionInput;
      appendGrilladeQuestionAsked(pi, question, askedAt);
      const normalizedQuestion = { ...normalizeGrilladeQuestion(question), askedAt };
      onUpdate?.({
        content: [
          {
            type: "text",
            text: `Persisted Grillade Question ${params.questionId}; waiting for user answer.`,
          },
        ],
        details: { status: "waiting", questionId: params.questionId },
      });

      const result = await askGrilladeQuestionInUi(ctx, normalizedQuestion, signal, {
        docsMode: state.metadata.docsMode,
      });
      if (result.status === "answered") {
        appendGrilladeAnswerSubmitted(pi, result);
        return formatQuestionToolResult(result, false);
      }

      const pausedAt = result.at;
      if (result.status === "paused") appendGrilladePaused(pi, pausedAt, result);
      return formatQuestionToolResult(result, true);
    },
  });

  pi.registerTool({
    name: GRILLADE_FINISH_TOOL_NAME,
    label: "Finish Grillade",
    description:
      "Finish a Grillade interview with structured final state and show the action-oriented completion screen.",
    promptSnippet: "Finish Grillade with a structured summary and final action menu",
    promptGuidelines: [
      "Finish active Grillade sessions through grillade_finish with summary, decisions, open questions/risks, recommended next action, and standard final actions.",
      "Put docs/glossary/ADR opportunities in docsProposalSummaries; if the selected action hands off to normal Pi, stop after the tool result.",
    ],
    parameters: GrilladeFinishInputSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const state = reconstructGrilladeState(ctx.sessionManager);
      if (!state) {
        return formatFinishToolResult(
          {
            status: "cancelled",
            reason: "No Grillade session is available to finish.",
            at: new Date().toISOString(),
          },
          true,
        );
      }

      const finishedAt = new Date().toISOString();
      const finish = params as GrilladeFinishInput;
      appendDocsProposalSummaries(pi, finish, finishedAt);
      appendGrilladeFinished(pi, finish, finishedAt);
      onUpdate?.({
        content: [
          {
            type: "text",
            text: "Persisted Grillade final state; waiting for final action selection.",
          },
        ],
        details: { status: "waiting", finishedAt },
      });

      const selected = await showGrilladeFinalScreenInUi(ctx, finish, signal, {
        docsMode: state.metadata.docsMode,
      });
      const effectiveSteering = selected.steering ?? defaultSteeringForAction(selected.actionId);
      appendGrilladeFinalActionSelected(
        pi,
        selected.actionId,
        selected.selectedAt,
        effectiveSteering,
      );

      if (isNormalPiHandoffAction(selected.actionId)) {
        closeGrilladeUi(ctx);
        queueNormalPiHandoff(pi, selected.actionId, finish, {
          originalPrompt: state.metadata.prompt,
          docsMode: state.metadata.docsMode,
          selectedAt: selected.selectedAt,
          ...(selected.steering ? { steering: selected.steering } : {}),
        });
      } else if (selected.actionId === "export_summary") {
        exportSummaryToEditor(ctx, finish);
        closeGrilladeUi(ctx);
      } else if (selected.actionId === "continue_grilling") {
        appendGrilladeResumed(pi, selected.selectedAt);
      } else if (selected.actionId === "close") {
        closeGrilladeUi(ctx);
      }

      return formatFinishToolResult(
        {
          status: "selected",
          actionId: selected.actionId,
          steering: effectiveSteering,
          selectedAt: selected.selectedAt,
        },
        selected.actionId !== "continue_grilling",
      );
    },
  });
}

function queueNormalPiHandoff(
  pi: Pick<ExtensionAPI, "sendUserMessage">,
  actionId: "implement_now" | "create_epic_issues" | "create_update_docs",
  finish: GrilladeFinishInput,
  options: Parameters<typeof buildNormalPiHandoffPrompt>[2],
): void {
  pi.sendUserMessage(buildNormalPiHandoffPrompt(actionId, finish, options), {
    deliverAs: "followUp",
  });
}

function closeGrilladeUi(ctx: {
  hasUI: boolean;
  ui: {
    setStatus(key: string, status: string | undefined): void;
    setWidget(key: string, value: undefined): void;
  };
}): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget("grillade-question", undefined);
  ctx.ui.setStatus("grillade", undefined);
}

function appendDocsProposalSummaries(
  pi: Pick<ExtensionAPI, "appendEntry">,
  finish: GrilladeFinishInput,
  finishedAt: string,
): void {
  for (const [index, summary] of finish.docsProposalSummaries?.entries() ?? []) {
    appendGrilladeDocsProposalUpdated(pi, {
      id: `finish-${finishedAt}-${index + 1}`,
      title: summarizeDocsProposalTitle(summary, index),
      summary,
      status: "proposed",
      updatedAt: finishedAt,
    });
  }
}

function summarizeDocsProposalTitle(summary: string, index: number): string {
  const firstLine = summary.replace(/\s+/g, " ").trim();
  if (!firstLine) return `Docs opportunity ${index + 1}`;
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79).trimEnd()}…`;
}

function formatQuestionToolResult(result: GrilladeQuestionResult, terminate: boolean) {
  const text =
    result.status === "answered"
      ? `Grillade question answered; continue from this result: ${JSON.stringify(result)}`
      : `Grillade question ${result.status}; stop until the user resumes Grillade: ${JSON.stringify(result)}`;
  return {
    content: [{ type: "text" as const, text }],
    details: result,
    ...(terminate ? { terminate: true } : {}),
  };
}

function formatFinishToolResult(result: Record<string, unknown>, terminate: boolean) {
  const actionId = result["actionId"];
  const text =
    result["status"] === "selected" && actionId === "continue_grilling"
      ? `Grillade final screen selected Continue grilling; ask the next Grillade Question using this result: ${JSON.stringify(result)}`
      : `${isQueuedHandoffAction(actionId) ? "Grillade finished; normal Pi handoff queued; stop now" : "Grillade finished; stop now"}: ${JSON.stringify(result)}`;
  return {
    content: [{ type: "text" as const, text }],
    details: result,
    ...(terminate ? { terminate: true } : {}),
  };
}

function isQueuedHandoffAction(actionId: unknown): boolean {
  return (
    actionId === "implement_now" ||
    actionId === "create_epic_issues" ||
    actionId === "create_update_docs"
  );
}

function defaultSteeringForAction(actionId: GrilladeFinalActionId): string {
  switch (actionId) {
    case "continue_grilling":
      return "Continue grilling from the final summary. Ask the next highest-leverage question about any remaining uncertainty or requested details.";
    case "implement_now":
      return "Prepare to implement the decided plan in normal Pi flow.";
    case "create_epic_issues":
      return "Prepare to create epic/issues from the decided plan in normal Pi flow.";
    case "create_update_docs":
      return "Prepare to create or update documentation from the decided plan in normal Pi flow.";
    case "export_summary":
      return "The Grillade summary was exported to the editor.";
    case "close":
      return "Close the final screen and remain in the Grillade session.";
  }
}

function exportSummaryToEditor(
  ctx: {
    hasUI: boolean;
    ui: {
      getEditorText(): string;
      setEditorText(text: string): void;
      notify(message: string, type?: "info" | "warning" | "error"): void;
    };
  },
  finish: GrilladeFinishInput,
): void {
  if (!ctx.hasUI) return;
  const markdown = formatGrilladeFinalMarkdown(finish);
  const existing = ctx.ui.getEditorText().trimEnd();
  ctx.ui.setEditorText(existing ? `${existing}\n\n${markdown}` : markdown);
  ctx.ui.notify("Exported Grillade summary to the editor.", "info");
}
