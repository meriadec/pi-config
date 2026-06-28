import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import type {
  GrilladeAnsweredResult,
  GrilladeQuestionResult,
  NormalizedGrilladeQuestion,
} from "../protocol.ts";
import type { ActiveGrilladeQuestion } from "../state.ts";
import { getGrilladeUiStyle, type GrilladeUiStyle } from "./styles.ts";

const OPTION_VIEWPORT_HEIGHT = 18;
const MIN_CARD_WIDTH = 24;
const GUTTER_WIDTH = 2;
const SAFE_RESET = "\x1b[0m";

export type GrilladeQuestionScreenMode = "waiting" | "active-work";
export type GrilladeQuestionScreenQuestion = NormalizedGrilladeQuestion | ActiveGrilladeQuestion;

export type GrilladeQuestionScreenResult = GrilladeQuestionResult;

export type GrilladeQuestionScreenOptions = {
  mode?: GrilladeQuestionScreenMode;
  docsMode?: boolean;
  onRenderNeeded?: () => void;
};

type FocusTarget = "options" | "input";

type SubmitSource = "selected-option" | "custom-answer";

type OverlayState = { kind: "none" } | { kind: "confirm-cancel" };

export class QuestionScreen implements Component, Focusable {
  private selectedIndex: number;
  private focusTarget: FocusTarget = "options";
  private scrollTop = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private overlay: OverlayState = { kind: "none" };
  private readonly input = new Input();
  private readonly mode: GrilladeQuestionScreenMode;
  private readonly docsMode: boolean | undefined;
  private readonly style: GrilladeUiStyle;
  private _focused = false;
  private readonly question: GrilladeQuestionScreenQuestion;
  private readonly theme: Theme;
  private readonly done: (result: GrilladeQuestionScreenResult) => void;
  private readonly options: GrilladeQuestionScreenOptions;

  constructor(
    question: GrilladeQuestionScreenQuestion,
    theme: Theme,
    done: (result: GrilladeQuestionScreenResult) => void,
    options: GrilladeQuestionScreenOptions = {},
  ) {
    this.question = question;
    this.theme = theme;
    this.done = done;
    this.options = options;
    this.mode = options.mode ?? "waiting";
    this.docsMode = options.docsMode;
    this.style = getGrilladeUiStyle(theme);
    this.selectedIndex = Math.max(
      0,
      question.options.findIndex((option) => option.id === question.recommendedOptionId),
    );
    this.input.onSubmit = () =>
      this.submit(this.focusTarget === "input" ? "custom-answer" : "selected-option");
    this.input.onEscape = () => this.closeOrConfirm();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  handleInput(data: string): void {
    if (this.overlay.kind === "confirm-cancel") {
      this.handleConfirmOverlayInput(data);
      return;
    }

    if (this.focusTarget === "input") {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.setFocusTarget("options");
        return;
      }
      this.input.handleInput(data);
      this.invalidateAndRender();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
    } else if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
    } else if (matchesKey(data, Key.home)) {
      this.selectIndex(0);
    } else if (matchesKey(data, Key.end)) {
      this.selectIndex(this.question.options.length - 1);
    } else if (matchesKey(data, Key.tab) || data === "a" || data === "c" || data === "i") {
      this.setFocusTarget("input");
    } else if (matchesKey(data, Key.enter)) {
      this.submit("selected-option");
    } else if (matchesKey(data, Key.escape)) {
      this.closeOrConfirm();
    } else {
      const numberIndex = optionNumberIndex(data, this.question.options.length);
      if (numberIndex !== undefined) this.selectIndex(numberIndex);
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const safeWidth = Math.max(1, width);
    const contentWidth = Math.max(MIN_CARD_WIDTH, safeWidth - GUTTER_WIDTH);
    const lines: string[] = [];
    lines.push(...this.renderHeader(contentWidth));
    lines.push("");
    lines.push(...this.renderQuestion(contentWidth));
    lines.push("");
    lines.push(...this.renderOptionViewport(contentWidth));
    lines.push("");
    lines.push(...this.renderInput(contentWidth));
    lines.push(...this.renderFooter(contentWidth));

    const fitted = lines.map((line) => truncateToWidth(line, safeWidth, "", false));
    if (this.overlay.kind === "confirm-cancel") {
      fitted.push(...this.renderConfirmOverlay(safeWidth));
    }
    this.cachedWidth = width;
    this.cachedLines = fitted;
    return fitted;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.input.invalidate();
  }

  private renderHeader(width: number): string[] {
    const phase = this.question.phase ?? "questioning";
    const progress = this.formatProgress();
    const docs = this.formatDocsMode();
    const title = this.style.accent(this.theme.bold("Grillade"));
    const statusParts = [phase, ...(progress ? [progress] : []), ...(docs ? [docs] : [])];
    const status = this.style.muted(statusParts.join(" • "));
    return [fitLine(`${title} ${status}`, width), this.style.border("─".repeat(width))];
  }

  private renderQuestion(width: number): string[] {
    const lines: string[] = [];
    lines.push(...wrapIndented(this.style.strong(this.question.question), width, "? ", "  "));
    if (this.question.context) {
      lines.push(
        ...wrapIndented(
          `${this.style.muted("Context:")} ${this.question.context}`,
          width,
          "  ",
          "  ",
        ),
      );
    }
    if (this.question.constraints?.length) {
      lines.push(this.style.muted("  Constraints:"));
      for (const constraint of this.question.constraints) {
        lines.push(...wrapIndented(constraint, width, "  • ", "    "));
      }
    }
    return lines.map((line) => fitLine(line, width));
  }

  private renderOptionViewport(width: number): string[] {
    const optionLines = this.renderAllOptionCards(width);
    const selectedRange = this.findSelectedCardRange(optionLines);
    this.scrollTop = clampScrollToSelected(
      this.scrollTop,
      selectedRange,
      OPTION_VIEWPORT_HEIGHT,
      optionLines.length,
    );
    const view = optionLines
      .slice(this.scrollTop, this.scrollTop + OPTION_VIEWPORT_HEIGHT)
      .map((line) => line.text);
    const hiddenAbove = this.scrollTop > 0;
    const hiddenBelow = this.scrollTop + OPTION_VIEWPORT_HEIGHT < optionLines.length;
    const title =
      hiddenAbove || hiddenBelow
        ? `Options ${hiddenAbove ? "▲" : " "}${hiddenBelow ? "▼" : " "}`
        : "Options";
    return [this.style.muted(title), ...view];
  }

  private renderAllOptionCards(width: number): Array<{ text: string; optionIndex?: number }> {
    const lines: Array<{ text: string; optionIndex?: number }> = [];
    for (const [index, option] of this.question.options.entries()) {
      if (index > 0) lines.push({ text: "" });
      const selected = index === this.selectedIndex;
      const recommended = option.id === this.question.recommendedOptionId;
      for (const text of renderOptionCard({
        index,
        width,
        selected,
        recommended,
        title: option.title,
        body: option.body,
        confidence: option.confidence,
        style: this.style,
        theme: this.theme,
      })) {
        lines.push({ text, optionIndex: index });
      }
    }
    return lines;
  }

  private findSelectedCardRange(lines: Array<{ optionIndex?: number }>): {
    start: number;
    end: number;
  } {
    const start = lines.findIndex((line) => line.optionIndex === this.selectedIndex);
    if (start < 0) return { start: 0, end: 0 };
    let end = start;
    while (end + 1 < lines.length && lines[end + 1]?.optionIndex === this.selectedIndex) end++;
    return { start, end };
  }

  private renderInput(width: number): string[] {
    const label =
      this.focusTarget === "input"
        ? this.style.accent("Custom answer / steering")
        : this.style.muted("Custom answer / steering");
    const hint =
      this.focusTarget === "input"
        ? this.style.dim(
            "Enter here submits this text as a custom answer; Tab returns to option cards.",
          )
        : this.style.dim(
            "Tab/a/c focuses this field; from option cards, entered text is sent as steering.",
          );
    const inputWidth = Math.max(1, width - 2);
    const renderedInput = this.input.render(inputWidth)[0] ?? "";
    return [
      fitLine(label, width),
      fitLine(
        `${this.focusTarget === "input" ? this.style.accent(">") : this.style.dim(">")} ${renderedInput}`,
        width,
      ),
      fitLine(hint, width),
    ];
  }

  private renderFooter(width: number): string[] {
    const modeHelp = this.mode === "active-work" ? "Esc confirm cancel" : "Esc pause";
    return [
      this.style.border("─".repeat(width)),
      fitLine(
        this.style.dim(
          `↑↓ navigate • 1–${this.question.options.length} jump • Enter submit • Tab/a/c custom/steering • ${modeHelp}`,
        ),
        width,
      ),
    ];
  }

  private renderConfirmOverlay(width: number): string[] {
    const overlayWidth = Math.min(width, Math.max(34, Math.floor(width * 0.75)));
    const innerWidth = Math.max(1, overlayWidth - 4);
    const border = this.style.warning("═".repeat(overlayWidth));
    const message = wrapTextWithAnsi(
      "Cancel active Grillade work? Press y to cancel, n or Esc to keep working.",
      innerWidth,
    );
    return [
      "",
      border,
      ...message.map((line) =>
        fitLine(
          `${this.style.warning("║")} ${line}${" ".repeat(Math.max(0, innerWidth - visibleWidth(line)))} ${this.style.warning("║")}`,
          overlayWidth,
        ),
      ),
      border,
    ].map((line) => centerLine(line, width));
  }

  private formatProgress(): string {
    const progress = this.question.progress;
    if (!progress) return "";
    const total = progress.totalHint ?? progress.maxHint;
    if (total !== undefined) return `${progress.answered + 1}/${total}`;
    return `question ${progress.answered + 1}`;
  }

  private formatDocsMode(): string {
    if (this.docsMode === undefined) return "";
    return this.docsMode ? "docs on" : "docs off";
  }

  private moveSelection(delta: number): void {
    this.selectIndex(this.selectedIndex + delta);
  }

  private selectIndex(index: number): void {
    const next = Math.max(0, Math.min(this.question.options.length - 1, index));
    if (next === this.selectedIndex && this.focusTarget === "options") return;
    this.selectedIndex = next;
    this.setFocusTarget("options");
    this.invalidateAndRender();
  }

  private setFocusTarget(target: FocusTarget): void {
    this.focusTarget = target;
    this.syncInputFocus();
    this.invalidateAndRender();
  }

  private syncInputFocus(): void {
    this.input.focused = this._focused && this.focusTarget === "input";
  }

  private submit(source: SubmitSource): void {
    const text = this.input.getValue().trim();
    const result: Omit<GrilladeAnsweredResult, "status" | "submittedAt"> = {
      questionId: this.question.questionId,
    };
    if (source === "custom-answer") {
      if (!text) return;
      result.customAnswer = text;
    } else {
      const option = this.question.options[this.selectedIndex];
      if (!option) return;
      result.selectedOptionId = option.id;
      if (text) result.steering = text;
    }
    this.done({ status: "answered", ...result, submittedAt: new Date().toISOString() });
  }

  private closeOrConfirm(): void {
    if (this.mode === "active-work") {
      this.overlay = { kind: "confirm-cancel" };
      this.invalidateAndRender();
      return;
    }
    this.done({
      status: "paused",
      questionId: this.question.questionId,
      reason: "Question UI closed with Esc.",
      at: new Date().toISOString(),
    });
  }

  private handleConfirmOverlayInput(data: string): void {
    if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
      this.done({
        status: "cancelled",
        questionId: this.question.questionId,
        reason: "Active Grillade work cancelled from confirmation overlay.",
        at: new Date().toISOString(),
      });
      return;
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
      this.overlay = { kind: "none" };
      this.invalidateAndRender();
    }
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.options.onRenderNeeded?.();
  }
}

type OptionCardInput = {
  index: number;
  width: number;
  selected: boolean;
  recommended: boolean;
  title: string;
  body: string;
  confidence: "low" | "medium" | "high";
  style: GrilladeUiStyle;
  theme: Theme;
};

function renderOptionCard(input: OptionCardInput): string[] {
  const borderStyle = input.selected
    ? input.style.accent
    : input.recommended
      ? input.style.recommended
      : input.style.border;
  const contentWidth = Math.max(1, input.width - 4);
  const number = `${input.index + 1}.`;
  const selection = input.selected ? "▶" : " ";
  const recommended = input.recommended ? input.style.recommended(" ★ recommended") : "";
  const confidenceText = input.style.confidence(
    input.confidence,
    `${confidenceLabel(input.confidence)} confidence`,
  );
  const header = `${selection} ${number} ${input.theme.bold(input.title)}${recommended} — ${confidenceText}`;
  const bodyLines = wrapTextWithAnsi(input.body, contentWidth);
  const headerLines = wrapTextWithAnsi(header, contentWidth);
  const rawLines = [...headerLines, "", ...bodyLines];
  const top = borderStyle(`╭${"─".repeat(Math.max(0, input.width - 2))}╮`);
  const bottom = borderStyle(`╰${"─".repeat(Math.max(0, input.width - 2))}╯`);
  return [
    top,
    ...rawLines.map((line) =>
      cardLine(line, input.width, borderStyle, input.selected ? input.style.selected : undefined),
    ),
    bottom,
  ];
}

function cardLine(
  line: string,
  width: number,
  borderStyle: (text: string) => string,
  bgStyle?: (text: string) => string,
): string {
  const contentWidth = Math.max(0, width - 4);
  const fitted = truncateToWidth(line, contentWidth, "…", false);
  const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
  const content = bgStyle ? bgStyle(`${fitted}${padding}`) : `${fitted}${padding}`;
  return `${borderStyle("│")} ${content}${SAFE_RESET} ${borderStyle("│")}`;
}

function confidenceLabel(confidence: "low" | "medium" | "high"): string {
  switch (confidence) {
    case "high":
      return "High";
    case "medium":
      return "Medium";
    case "low":
      return "Low";
  }
}

function wrapIndented(
  text: string,
  width: number,
  firstPrefix: string,
  nextPrefix: string,
): string[] {
  const firstWidth = Math.max(1, width - visibleWidth(firstPrefix));
  const nextWidth = Math.max(1, width - visibleWidth(nextPrefix));
  const wrapped = wrapTextWithAnsi(text, firstWidth);
  return wrapped.flatMap((line, index) => {
    if (index === 0) return [`${firstPrefix}${line}`];
    return wrapTextWithAnsi(line, nextWidth).map((continued) => `${nextPrefix}${continued}`);
  });
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, width, "", false);
}

function centerLine(line: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(line)) / 2));
  return fitLine(`${" ".repeat(left)}${line}`, width);
}

function optionNumberIndex(data: string, optionCount: number): number | undefined {
  if (!/^[1-9]$/.test(data)) return undefined;
  const index = Number.parseInt(data, 10) - 1;
  return index >= 0 && index < optionCount ? index : undefined;
}

function clampScrollToSelected(
  scrollTop: number,
  selectedRange: { start: number; end: number },
  viewportHeight: number,
  totalLines: number,
): number {
  let next = scrollTop;
  if (selectedRange.start < next) next = selectedRange.start;
  if (selectedRange.end >= next + viewportHeight) next = selectedRange.end - viewportHeight + 1;
  return Math.max(0, Math.min(Math.max(0, totalLines - viewportHeight), next));
}
