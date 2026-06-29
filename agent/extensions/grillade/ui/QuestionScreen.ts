import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Key,
  decodeKittyPrintable,
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

const FULLSCREEN_FILL_LINES = 200;
const FALLBACK_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT = 14;
const MIN_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT = 4;
const FOCUSED_CHOICE_CARD_CHROME_HEIGHT = 8;
const MIN_CONTENT_WIDTH = 32;
const GUTTER_WIDTH = 2;
const SAFE_RESET = "\x1b[0m";

export type GrilladeQuestionScreenMode = "waiting" | "active-work";
export type GrilladeQuestionScreenQuestion = NormalizedGrilladeQuestion | ActiveGrilladeQuestion;

export type GrilladeQuestionScreenResult = GrilladeQuestionResult;

export type GrilladeQuestionScreenOptions = {
  mode?: GrilladeQuestionScreenMode;
  docsMode?: boolean;
  onRenderNeeded?: () => void;
  getViewportHeight?: () => number;
};

type FocusTarget = "choice" | "custom";

type OverlayState = { kind: "none" } | { kind: "confirm-cancel" };

type SubmittedState = {
  label: string;
};

export class QuestionScreen implements Component, Focusable {
  private selectedIndex: number;
  private focusTarget: FocusTarget = "choice";
  private choiceScrollTop = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private overlay: OverlayState = { kind: "none" };
  private submitted: SubmittedState | undefined;
  private readonly input = new MultilineCustomAnswerInput();
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
    this.input.onSubmit = () => this.submitCustomAnswer();
    this.input.onEscape = () => this.setFocusTarget("choice");
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

    if (this.submitted) return;

    if (this.focusTarget === "custom") {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.setFocusTarget("choice");
        return;
      }
      this.input.handleInput(data);
      this.invalidateAndRender();
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.moveSelection(-1);
    } else if (matchesKey(data, Key.right)) {
      this.moveSelection(1);
    } else if (matchesKey(data, Key.up)) {
      this.scrollFocusedChoice(-1);
    } else if (matchesKey(data, Key.down)) {
      this.scrollFocusedChoice(1);
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollFocusedChoice(-this.currentFocusedChoiceBodyViewportHeight());
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollFocusedChoice(this.currentFocusedChoiceBodyViewportHeight());
    } else if (matchesKey(data, Key.home)) {
      this.selectIndex(0);
    } else if (matchesKey(data, Key.end)) {
      this.selectIndex(this.question.options.length - 1);
    } else if (this.canUseCustomAnswer() && (matchesKey(data, Key.tab) || isCustomShortcut(data))) {
      this.setFocusTarget("custom");
    } else if (matchesKey(data, Key.enter)) {
      this.submitSelectedOption();
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
    const contentWidth = Math.max(MIN_CONTENT_WIDTH, safeWidth - GUTTER_WIDTH);
    const lines: string[] = [];
    const footer = this.renderFooter(contentWidth);
    lines.push(...this.renderHeader(contentWidth));
    lines.push("");
    if (this.submitted) {
      lines.push(...this.renderSubmitted(contentWidth));
      lines.push(...footer);
      lines.push(...this.renderScreenFill(lines.length));
      const fitted = lines.map((line) => truncateToWidth(line, safeWidth, "", false));
      this.cachedWidth = width;
      this.cachedLines = fitted;
      return fitted;
    }
    lines.push(...this.renderQuestion(contentWidth));
    lines.push("");
    lines.push(...this.renderChoiceStrip(contentWidth));
    lines.push("");
    if (this.focusTarget === "custom") {
      lines.push(...this.renderCustomAnswer(contentWidth));
    } else {
      const customAffordance = this.renderCustomAffordance(contentWidth);
      lines.push(
        ...this.renderFocusedChoice(
          contentWidth,
          this.calculateFocusedChoiceBodyViewportHeight({
            renderedBeforeChoice: lines.length,
            renderedAfterChoice: 1 + customAffordance.length + footer.length,
          }),
        ),
      );
      lines.push("");
      lines.push(...customAffordance);
    }
    lines.push(...footer);
    lines.push(...this.renderScreenFill(lines.length));

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
    const title = this.theme.bold("Grillade");
    const statusParts = [phase, ...(progress ? [progress] : []), ...(docs ? [docs] : [])];
    const label = `${title} ${statusParts.join(" • ")}`;
    return [this.style.selected(padLine(` ${label} `, width))];
  }

  private renderSubmitted(width: number): string[] {
    if (!this.submitted) return [];
    const border = this.style.accent;
    const title = `${this.style.recommended("● Answer submitted")} ${this.style.muted("waiting for next Grillade question…")}`;
    const detail = `Submitted: ${this.submitted.label}`;
    const guidance =
      "Keep this screen open; Pi is thinking. The next question or the final Grillade screen will replace this in place.";
    return [
      border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      cardLine(title, width, border),
      cardLine("", width, border),
      ...wrapTextWithAnsi(detail, Math.max(1, width - 4)).map((line) =>
        cardLine(this.style.strong(line), width, border),
      ),
      cardLine("", width, border),
      ...wrapTextWithAnsi(guidance, Math.max(1, width - 4)).map((line) =>
        cardLine(this.style.muted(line), width, border),
      ),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  private renderQuestion(width: number): string[] {
    const lines: string[] = [];
    lines.push(...wrapIndented(this.style.strong(this.question.question), width, "? ", "  "));
    if (this.question.context) {
      lines.push("");
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
      lines.push("");
      lines.push(this.style.muted("  Constraints"));
      for (const constraint of this.question.constraints) {
        lines.push(...wrapIndented(constraint, width, "  • ", "    "));
      }
    }
    return lines.map((line) => fitLine(line, width));
  }

  private renderChoiceStrip(width: number): string[] {
    const parts = this.question.options.map((option, index) => {
      const selected = this.focusTarget === "choice" && index === this.selectedIndex;
      const recommended = option.id === this.question.recommendedOptionId;
      const label = `${index + 1} ${truncatePlain(option.title, 22)}${recommended ? " ★" : ""}`;
      if (selected) return this.style.selected(` ${label} `);
      if (recommended) return this.style.recommended(label);
      return this.style.muted(label);
    });
    if (this.canUseCustomAnswer()) {
      const custom =
        this.focusTarget === "custom"
          ? this.style.selected(" C Custom ")
          : this.style.muted("C Custom");
      parts.push(custom);
    }
    return [fitLine(`${this.style.dim("Choices:")} ${parts.join(this.style.dim("  │  "))}`, width)];
  }

  private renderFocusedChoice(width: number, bodyViewportHeight: number): string[] {
    const option = this.question.options[this.selectedIndex];
    if (!option) return [this.style.warning("No option is available for this question.")];
    const recommended = option.id === this.question.recommendedOptionId;
    const rendered = renderFocusedChoiceCard({
      index: this.selectedIndex,
      count: this.question.options.length,
      width,
      recommended,
      title: option.title,
      body: option.body,
      confidence: option.confidence,
      style: this.style,
      theme: this.theme,
      scrollTop: this.choiceScrollTop,
      bodyViewportHeight,
    });
    this.choiceScrollTop = rendered.scrollTop;
    return rendered.lines;
  }

  private renderCustomAffordance(width: number): string[] {
    if (!this.canUseCustomAnswer()) return [];
    return [
      fitLine(
        this.style.dim(
          "Custom answer is available with C. It can override the framing or add steering.",
        ),
        width,
      ),
    ];
  }

  private calculateFocusedChoiceBodyViewportHeight(input: {
    renderedBeforeChoice: number;
    renderedAfterChoice: number;
  }): number {
    const viewportHeight = this.options.getViewportHeight?.();
    if (!viewportHeight) return FALLBACK_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT;
    const availableCardHeight =
      viewportHeight - input.renderedBeforeChoice - input.renderedAfterChoice;
    return Math.max(
      MIN_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT,
      availableCardHeight - FOCUSED_CHOICE_CARD_CHROME_HEIGHT,
    );
  }

  private currentFocusedChoiceBodyViewportHeight(): number {
    return Math.max(
      MIN_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT,
      this.options.getViewportHeight?.() ?? FALLBACK_FOCUSED_CHOICE_BODY_VIEWPORT_HEIGHT,
    );
  }

  private renderCustomAnswer(width: number): string[] {
    const title = this.style.accent(this.theme.bold("Custom answer / steering"));
    const body =
      "Type your own direction, correction, constraint, or wrap-up request. Shift+Enter inserts a newline; Enter submits this text; pasted line breaks are preserved; Esc or Tab returns to the suggested choices.";
    const inputWidth = Math.max(1, width - 4);
    const renderedInput = this.input.render(inputWidth);
    const bodyLines = wrapTextWithAnsi(body, Math.max(1, width - 4));
    const border = this.style.accent;
    return [
      border(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
      cardLine(title, width, border),
      cardLine("", width, border),
      ...bodyLines.map((line) => cardLine(this.style.muted(line), width, border)),
      cardLine("", width, border),
      ...renderedInput.map((line) => cardLine(line, width, border)),
      border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
    ];
  }

  private renderScreenFill(currentLineCount: number): string[] {
    const missing = FULLSCREEN_FILL_LINES - currentLineCount;
    return Array.from({ length: Math.max(1, missing) }, () => "");
  }

  private renderFooter(width: number): string[] {
    if (this.submitted) {
      return [
        fillLine(this.style.dim(" Waiting for Pi — next Grillade UI will appear here "), width),
      ];
    }
    const modeHelp = this.mode === "active-work" ? "Esc confirm cancel" : "Esc pause";
    const customHelp = this.canUseCustomAnswer() ? " • C custom" : "";
    return [
      fillLine(
        this.style.dim(
          ` ←/→ choices • ↑/↓ scroll • 1–${this.question.options.length} jump • Enter choose${customHelp} • ${modeHelp} `,
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

  private scrollFocusedChoice(delta: number): void {
    this.choiceScrollTop = Math.max(0, this.choiceScrollTop + delta);
    this.invalidateAndRender();
  }

  private selectIndex(index: number): void {
    if (this.canUseCustomAnswer() && index >= this.question.options.length) {
      this.setFocusTarget("custom");
      return;
    }
    const next = Math.max(0, Math.min(this.question.options.length - 1, index));
    if (next === this.selectedIndex && this.focusTarget === "choice") return;
    this.selectedIndex = next;
    this.choiceScrollTop = 0;
    this.setFocusTarget("choice");
  }

  private setFocusTarget(target: FocusTarget): void {
    if (target === "custom" && !this.canUseCustomAnswer()) return;
    this.focusTarget = target;
    this.syncInputFocus();
    this.invalidateAndRender();
  }

  private syncInputFocus(): void {
    this.input.focused = this._focused && this.focusTarget === "custom";
  }

  private canUseCustomAnswer(): boolean {
    return this.question.allowCustomAnswer !== false;
  }

  private submitSelectedOption(): void {
    if (this.submitted) return;
    const option = this.question.options[this.selectedIndex];
    if (!option) return;
    this.submitAnswer(
      {
        status: "answered",
        questionId: this.question.questionId,
        selectedOptionId: option.id,
        submittedAt: new Date().toISOString(),
      },
      option.title,
    );
  }

  private submitCustomAnswer(): void {
    if (this.submitted || !this.canUseCustomAnswer()) return;
    const text = this.input.getValue().trim();
    if (!text) return;
    const result: Omit<GrilladeAnsweredResult, "status" | "submittedAt"> = {
      questionId: this.question.questionId,
      customAnswer: text,
    };
    this.submitAnswer(
      { status: "answered", ...result, submittedAt: new Date().toISOString() },
      text,
    );
  }

  private submitAnswer(result: GrilladeAnsweredResult, label: string): void {
    this.submitted = { label };
    this.setFocusTarget("choice");
    this.invalidateAndRender();
    this.done(result);
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

class MultilineCustomAnswerInput implements Component, Focusable {
  private static readonly maxVisibleLines = 8;

  private value = "";
  private cursor = 0;
  private isInPaste = false;
  private pasteBuffer = "";
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  getValue(): string {
    return this.value;
  }

  handleInput(data: string): void {
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }

    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
      if (endIndex !== -1) {
        const pastedText = this.pasteBuffer.slice(0, endIndex);
        this.insertText(pastedText);
        this.isInPaste = false;
        const remaining = this.pasteBuffer.slice(endIndex + "\x1b[201~".length);
        this.pasteBuffer = "";
        if (remaining) this.handleInput(remaining);
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.onEscape?.();
      return;
    }
    if (isNewlineInput(data)) {
      this.insertText("\n");
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.onSubmit?.(this.value);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.deleteBeforeCursor();
      return;
    }
    if (matchesKey(data, Key.delete)) {
      this.deleteAfterCursor();
      return;
    }
    if (matchesKey(data, Key.left)) {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, Key.right)) {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.moveToLineStart();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.moveToLineEnd();
      return;
    }

    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.insertText(kittyPrintable);
      return;
    }
    if (isInsertableText(data)) {
      this.insertText(data);
    }
  }

  invalidate(): void {
    // No cached state.
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const logicalLines = this.value.split("\n");
    const cursorPosition = this.cursorLineAndColumn();
    const maxVisibleLines = MultilineCustomAnswerInput.maxVisibleLines;
    const maxStart = Math.max(0, logicalLines.length - maxVisibleLines);
    const startLine = Math.max(
      0,
      Math.min(cursorPosition.lineIndex - Math.floor(maxVisibleLines / 2), maxStart),
    );
    const visibleLines = logicalLines.slice(startLine, startLine + maxVisibleLines);
    const rendered: string[] = [];

    if (startLine > 0) rendered.push(`… ${startLine} line${startLine === 1 ? "" : "s"} above`);
    for (let offset = 0; offset < visibleLines.length; offset += 1) {
      const lineIndex = startLine + offset;
      rendered.push(this.renderLogicalLine(logicalLines[lineIndex] ?? "", lineIndex, safeWidth));
    }
    const hiddenBelow = logicalLines.length - (startLine + visibleLines.length);
    if (hiddenBelow > 0) {
      rendered.push(`… ${hiddenBelow} line${hiddenBelow === 1 ? "" : "s"} below`);
    }

    return rendered;
  }

  private renderLogicalLine(line: string, lineIndex: number, width: number): string {
    const prompt = lineIndex === 0 ? "> " : "  ";
    const availableWidth = Math.max(1, width - visibleWidth(prompt));
    const cursorPosition = this.cursorLineAndColumn();
    if (lineIndex !== cursorPosition.lineIndex) {
      return `${prompt}${truncateToWidth(line, availableWidth, "…", false)}`;
    }

    const beforeCursor = line.slice(0, cursorPosition.column);
    const atCursor = line.slice(cursorPosition.column, cursorPosition.column + 1) || " ";
    const afterCursor = line.slice(cursorPosition.column + atCursor.length);
    const marker = this.focused ? CURSOR_MARKER : "";
    const cursor = `\x1b[7m${atCursor}\x1b[27m`;
    return `${prompt}${truncateToWidth(`${beforeCursor}${marker}${cursor}${afterCursor}`, availableWidth, "", false)}`;
  }

  private insertText(text: string): void {
    const normalized = normalizeMultilineInputText(text);
    if (!normalized) return;
    this.value = `${this.value.slice(0, this.cursor)}${normalized}${this.value.slice(this.cursor)}`;
    this.cursor += normalized.length;
  }

  private deleteBeforeCursor(): void {
    if (this.cursor <= 0) return;
    const before = this.value.slice(0, this.cursor);
    const beforeGraphemes = Array.from(before);
    beforeGraphemes.pop();
    const nextBefore = beforeGraphemes.join("");
    this.value = `${nextBefore}${this.value.slice(this.cursor)}`;
    this.cursor = nextBefore.length;
  }

  private deleteAfterCursor(): void {
    if (this.cursor >= this.value.length) return;
    const after = this.value.slice(this.cursor);
    const afterGraphemes = Array.from(after);
    afterGraphemes.shift();
    this.value = `${this.value.slice(0, this.cursor)}${afterGraphemes.join("")}`;
  }

  private moveCursor(delta: -1 | 1): void {
    if (delta < 0) {
      if (this.cursor <= 0) return;
      const beforeGraphemes = Array.from(this.value.slice(0, this.cursor));
      const previous = beforeGraphemes.at(-1);
      this.cursor -= previous?.length ?? 1;
      return;
    }
    if (this.cursor >= this.value.length) return;
    const next = Array.from(this.value.slice(this.cursor)).at(0);
    this.cursor += next?.length ?? 1;
  }

  private moveToLineStart(): void {
    this.cursor = this.value.lastIndexOf("\n", Math.max(0, this.cursor - 1)) + 1;
  }

  private moveToLineEnd(): void {
    const nextLineBreak = this.value.indexOf("\n", this.cursor);
    this.cursor = nextLineBreak === -1 ? this.value.length : nextLineBreak;
  }

  private cursorLineAndColumn(): { lineIndex: number; column: number } {
    const beforeCursor = this.value.slice(0, this.cursor);
    const lines = beforeCursor.split("\n");
    return {
      lineIndex: lines.length - 1,
      column: lines.at(-1)?.length ?? 0,
    };
  }
}

type FocusedChoiceCardInput = {
  index: number;
  count: number;
  width: number;
  recommended: boolean;
  title: string;
  body: string;
  confidence: "low" | "medium" | "high";
  style: GrilladeUiStyle;
  theme: Theme;
  scrollTop: number;
  bodyViewportHeight: number;
};

type FocusedChoiceCardRender = {
  lines: string[];
  scrollTop: number;
};

function renderFocusedChoiceCard(input: FocusedChoiceCardInput): FocusedChoiceCardRender {
  const borderStyle = input.recommended ? input.style.recommended : input.style.accent;
  const contentWidth = Math.max(1, input.width - 4);
  const optionLabel = input.style.muted(`Option ${input.index + 1} of ${input.count}`);
  const recommended = input.recommended ? input.style.recommended(" ★ recommended") : "";
  const confidenceText = input.style.confidence(
    input.confidence,
    `${confidenceLabel(input.confidence)} confidence`,
  );
  const header = `${optionLabel}  ${input.theme.bold(input.title)}${recommended}`;
  const bodyLines = wrapTextWithAnsi(input.body, contentWidth);
  const bodyViewportHeight = Math.max(1, input.bodyViewportHeight);
  const maxScrollTop = Math.max(0, bodyLines.length - bodyViewportHeight);
  const scrollTop = Math.max(0, Math.min(input.scrollTop, maxScrollTop));
  const visibleBodyLines = bodyLines.slice(scrollTop, scrollTop + bodyViewportHeight);
  const scrollStatus = formatScrollStatus({
    scrollTop,
    visibleCount: visibleBodyLines.length,
    totalCount: bodyLines.length,
    viewportHeight: bodyViewportHeight,
    style: input.style,
  });
  const meta = input.style.dim(confidenceText);
  const rawLines = [
    header,
    "",
    ...(scrollStatus ? [scrollStatus, ""] : []),
    ...visibleBodyLines,
    "",
    meta,
  ];
  const top = borderStyle(`╭${"─".repeat(Math.max(0, input.width - 2))}╮`);
  const bottom = borderStyle(`╰${"─".repeat(Math.max(0, input.width - 2))}╯`);
  return {
    lines: [top, ...rawLines.map((line) => cardLine(line, input.width, borderStyle)), bottom],
    scrollTop,
  };
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

function formatScrollStatus(input: {
  scrollTop: number;
  visibleCount: number;
  totalCount: number;
  viewportHeight: number;
  style: GrilladeUiStyle;
}): string {
  if (input.totalCount <= input.viewportHeight) return "";
  const start = input.scrollTop + 1;
  const end = input.scrollTop + input.visibleCount;
  const above = input.scrollTop > 0 ? "▲" : " ";
  const below = end < input.totalCount ? "▼" : " ";
  return input.style.dim(
    `Body ${above}${below} lines ${start}–${end}/${input.totalCount} · ↑/↓ scroll`,
  );
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

function fillLine(line: string, width: number): string {
  const fitted = fitLine(line, width);
  return padLine(fitted, width);
}

function padLine(line: string, width: number): string {
  return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
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

function isCustomShortcut(data: string): boolean {
  return data === "c" || data === "C";
}

function isNewlineInput(data: string): boolean {
  return (
    matchesKey(data, Key.shift("enter")) ||
    data === "\n" ||
    data === "\x1b\r" ||
    data === "\x1b[13;2~"
  );
}

function isInsertableText(data: string): boolean {
  if (!data) return false;
  return [...data].every((character) => {
    const code = character.charCodeAt(0);
    return (
      character === "\n" ||
      character === "\r" ||
      character === "\t" ||
      (code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))
    );
  });
}

function normalizeMultilineInputText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

function truncatePlain(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
