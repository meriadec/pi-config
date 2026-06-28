import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI, KeybindingsManager, Component } from "@earendil-works/pi-tui";
import type { GrilladeQuestionResult } from "../protocol.ts";
import {
  QuestionScreen,
  type GrilladeQuestionScreenMode,
  type GrilladeQuestionScreenQuestion,
} from "./QuestionScreen.ts";

export type GrilladeQuestionViewOptions = {
  mode?: GrilladeQuestionScreenMode;
  docsMode?: boolean;
};

export function createGrilladeQuestionView(
  tui: TUI,
  theme: Theme,
  _keybindings: KeybindingsManager,
  done: (result: GrilladeQuestionResult) => void,
  question: GrilladeQuestionScreenQuestion,
  options: GrilladeQuestionViewOptions = {},
): Component {
  const screenOptions = {
    onRenderNeeded: () => tui.requestRender(),
    ...(options.mode !== undefined ? { mode: options.mode } : {}),
    ...(options.docsMode !== undefined ? { docsMode: options.docsMode } : {}),
  };
  return new QuestionScreen(question, theme, done, screenOptions);
}
