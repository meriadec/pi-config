import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GrilladeFinishInput } from "../protocol.ts";
import { FinalScreen, type GrilladeFinalScreenResult } from "./FinalScreen.ts";

const WIDGET_KEY = "grillade-question";

export type GrilladeFinalUiContext = Pick<ExtensionContext, "mode" | "hasUI" | "ui">;

export type GrilladeFinalUiOptions = {
  docsMode?: boolean;
};

export async function showGrilladeFinalScreenInUi(
  ctx: GrilladeFinalUiContext,
  finish: GrilladeFinishInput,
  signal?: AbortSignal,
  options: GrilladeFinalUiOptions = {},
): Promise<GrilladeFinalScreenResult> {
  const fallback = (): GrilladeFinalScreenResult => ({
    actionId: "close",
    selectedAt: new Date().toISOString(),
  });

  if (ctx.mode !== "tui" || !ctx.hasUI) return fallback();

  ctx.ui.setStatus("grillade", formatFinalStatus(options.docsMode));
  ctx.ui.setWidget(WIDGET_KEY, undefined);

  return await new Promise<GrilladeFinalScreenResult>((resolve) => {
    let settled = false;
    let disposeAbort: (() => void) | undefined;
    let closeCustomUi: ((result: GrilladeFinalScreenResult) => void) | undefined;
    const finishResult = (result: GrilladeFinalScreenResult): void => {
      if (settled) return;
      settled = true;
      disposeAbort?.();
      resolve(result);
    };
    const closeAndFinish = (result: GrilladeFinalScreenResult): void => {
      if (settled) return;
      if (closeCustomUi) closeCustomUi(result);
      else finishResult(result);
    };

    if (signal) {
      const abort = (): void => closeAndFinish(fallback());
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      disposeAbort = () => signal.removeEventListener("abort", abort);
    }

    void ctx.ui
      .custom<GrilladeFinalScreenResult>((tui, theme, _keybindings, done) => {
        closeCustomUi = done;
        return new FinalScreen(finish, theme, closeAndFinish, {
          ...options,
          onRenderNeeded: () => tui.requestRender(),
        });
      })
      .then(finishResult, () => finishResult(fallback()));
  });
}

function formatFinalStatus(docsMode: boolean | undefined): string {
  if (docsMode === undefined) return "Grillade complete";
  return docsMode ? "Grillade complete • docs" : "Grillade complete • no docs";
}

export function formatGrilladeFinalMarkdown(finish: GrilladeFinishInput): string {
  const lines = [
    "# Grillade summary",
    "",
    "## Summary",
    finish.summary,
    "",
    "## Decisions",
    ...formatList(finish.decisions),
    "",
    "## Open questions / risks",
    ...formatList(finish.openQuestions ?? [], "None captured."),
    "",
    "## Recommended next action",
    formatActionLabel(finish.recommendedNextAction),
  ];
  if (finish.docsProposalSummaries?.length) {
    lines.push("", "## Docs opportunities", ...formatList(finish.docsProposalSummaries));
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatList(items: readonly string[], emptyText = "None captured."): string[] {
  if (items.length === 0) return [emptyText];
  return items.map((item) => `- ${item}`);
}

function formatActionLabel(actionId: GrilladeFinishInput["recommendedNextAction"]): string {
  switch (actionId) {
    case "implement_now":
      return "Implement now";
    case "create_epic_issues":
      return "Create epic/issues";
    case "create_update_docs":
      return "Create/update docs in Pi";
    case "continue_grilling":
      return "Continue grilling / add details";
    case "export_summary":
      return "Export summary";
    case "close":
      return "Close";
  }
}
