import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setDesktopUrgent } from "../../lib/desktopUrgency.ts";
import type { ActiveGrilladeQuestion } from "../state.ts";
import type { GrilladeQuestionResult, NormalizedGrilladeQuestion } from "../protocol.ts";
import { createGrilladeQuestionView, type GrilladeQuestionViewOptions } from "./GrilladeView.ts";
import {
  closeGrilladePreparingScreen,
  GRILLADE_FULLSCREEN_OVERLAY_OPTIONS,
} from "./PreparingScreen.ts";

const WIDGET_KEY = "grillade-question";

let closeActiveQuestionUi: (() => void) | undefined;

export function closeGrilladeQuestionUi(): void {
  const close = closeActiveQuestionUi;
  closeActiveQuestionUi = undefined;
  close?.();
}

export type GrilladeQuestionUiContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

export type GrilladeQuestionUiOptions = Pick<GrilladeQuestionViewOptions, "docsMode" | "mode">;

export async function askGrilladeQuestionInUi(
  ctx: GrilladeQuestionUiContext,
  question: NormalizedGrilladeQuestion | ActiveGrilladeQuestion,
  signal?: AbortSignal,
  options: GrilladeQuestionUiOptions = {},
): Promise<GrilladeQuestionResult> {
  const at = () => new Date().toISOString();
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    return {
      status: "paused",
      questionId: question.questionId,
      reason: "Grillade questions require interactive Pi TUI mode.",
      at: at(),
    };
  }

  closeGrilladeQuestionUi();
  setDesktopUrgent(true);
  ctx.ui.setStatus("grillade", formatStatus(question, options.docsMode));
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setWorkingMessage(undefined);
  ctx.ui.setWorkingIndicator();
  closeGrilladePreparingScreen();

  return await new Promise<GrilladeQuestionResult>((resolve) => {
    let settled = false;
    let disposeAbort: (() => void) | undefined;
    let closeCustomUi: ((result: GrilladeQuestionResult) => void) | undefined;
    let closeThisQuestionUi: (() => void) | undefined;
    const finish = (result: GrilladeQuestionResult): void => {
      if (settled) return;
      settled = true;
      disposeAbort?.();
      resolve(result);
    };
    const closeUi = (result: GrilladeQuestionResult): void => {
      if (closeCustomUi) closeCustomUi(result);
      else finish(result);
    };
    const closeAndFinish = (result: GrilladeQuestionResult): void => {
      if (settled) return;
      closeUi(result);
    };
    const handleQuestionResult = (result: GrilladeQuestionResult): void => {
      if (result.status === "answered") finish(result);
      else closeAndFinish(result);
    };

    if (signal) {
      const abort = (): void =>
        closeAndFinish(
          paused(question.questionId, "Question UI aborted while waiting for an answer."),
        );
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      disposeAbort = () => signal.removeEventListener("abort", abort);
    }

    void ctx.ui
      .custom<GrilladeQuestionResult>(
        (tui, theme, keybindings, done) => {
          closeCustomUi = done;
          closeThisQuestionUi = (): void => {
            closeUi(
              paused(question.questionId, "Question UI replaced by the next Grillade screen."),
            );
          };
          closeActiveQuestionUi = closeThisQuestionUi;
          return createGrilladeQuestionView(
            tui,
            theme,
            keybindings,
            handleQuestionResult,
            question,
            options,
          );
        },
        { overlay: true, overlayOptions: GRILLADE_FULLSCREEN_OVERLAY_OPTIONS },
      )
      .then(
        (result) => {
          if (closeActiveQuestionUi === closeThisQuestionUi) closeActiveQuestionUi = undefined;
          finish(result);
        },
        () => {
          if (closeActiveQuestionUi === closeThisQuestionUi) closeActiveQuestionUi = undefined;
          finish(paused(question.questionId, "Question UI closed unexpectedly."));
        },
      );
  });
}

function paused(questionId: string, reason: string): GrilladeQuestionResult {
  return {
    status: "paused",
    questionId,
    reason,
    at: new Date().toISOString(),
  };
}

function formatStatus(
  question: NormalizedGrilladeQuestion | ActiveGrilladeQuestion,
  docsMode: boolean | undefined,
): string {
  const docsSuffix = docsMode === undefined ? "" : docsMode ? " • docs" : " • no docs";
  const progress = question.progress;
  if (!progress) return `Grillade ${question.phase ?? "questioning"}${docsSuffix}`;
  const total = progress.totalHint ?? progress.maxHint;
  if (total !== undefined) return `Grillade ${progress.answered + 1}/${total}${docsSuffix}`;
  return `Grillade question ${progress.answered + 1}${docsSuffix}`;
}
