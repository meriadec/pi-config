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
import {
  GRILLADE_FINAL_ACTION_IDS,
  type GrilladeFinalAction,
  type GrilladeFinalActionId,
  type GrilladeFinishInput,
} from "../protocol.ts";
import { getGrilladeUiStyle, type GrilladeUiStyle } from "./styles.ts";

const SUMMARY_VIEWPORT_HEIGHT = 14;
const MIN_CONTENT_WIDTH = 32;
const GUTTER_WIDTH = 2;

const DEFAULT_ACTIONS: Record<GrilladeFinalActionId, GrilladeFinalAction> = {
  implement_now: {
    id: "implement_now",
    label: "Implement now",
    description: "Hand off the decided plan to normal Pi implementation work.",
  },
  create_epic_issues: {
    id: "create_epic_issues",
    label: "Create epic/issues",
    description: "Turn the plan into repository issue or epic artifacts.",
  },
  create_update_docs: {
    id: "create_update_docs",
    label: "Create/update docs in Pi",
    description: "Preserve decisions in docs, glossary, or ADRs using repo conventions.",
  },
  continue_grilling: {
    id: "continue_grilling",
    label: "Continue grilling / add details",
    description: "Reopen the interview loop with optional steering below.",
  },
  export_summary: {
    id: "export_summary",
    label: "Export summary",
    description: "Place a markdown summary in a visible, non-destructive editor surface.",
  },
  close: {
    id: "close",
    label: "Close",
    description: "Close this screen and stay in the Grillade session.",
  },
};

export type GrilladeFinalScreenResult = {
  actionId: GrilladeFinalActionId;
  steering?: string;
  selectedAt: string;
};

export type GrilladeFinalScreenOptions = {
  docsMode?: boolean;
  onRenderNeeded?: () => void;
};

type FocusTarget = "actions" | "input";

export class FinalScreen implements Component, Focusable {
  private selectedIndex: number;
  private focusTarget: FocusTarget = "actions";
  private scrollTop = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly input = new Input();
  private readonly style: GrilladeUiStyle;
  private _focused = false;
  private readonly finish: GrilladeFinishInput;
  private readonly theme: Theme;
  private readonly done: (result: GrilladeFinalScreenResult) => void;
  private readonly options: GrilladeFinalScreenOptions;
  private readonly actions: GrilladeFinalAction[];

  constructor(
    finish: GrilladeFinishInput,
    theme: Theme,
    done: (result: GrilladeFinalScreenResult) => void,
    options: GrilladeFinalScreenOptions = {},
  ) {
    this.finish = finish;
    this.theme = theme;
    this.done = done;
    this.options = options;
    this.style = getGrilladeUiStyle(theme);
    this.actions = normalizeFinalActions(finish.availableActions);
    this.selectedIndex = Math.max(
      0,
      this.actions.findIndex((action) => action.id === finish.recommendedNextAction),
    );
    this.input.onSubmit = () => this.submit();
    this.input.onEscape = () => this.setFocusTarget("actions");
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncInputFocus();
  }

  handleInput(data: string): void {
    if (this.focusTarget === "input") {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
        this.setFocusTarget("actions");
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
    } else if (matchesKey(data, Key.pageUp)) {
      this.scrollSummary(-SUMMARY_VIEWPORT_HEIGHT);
    } else if (matchesKey(data, Key.pageDown)) {
      this.scrollSummary(SUMMARY_VIEWPORT_HEIGHT);
    } else if (matchesKey(data, Key.home)) {
      this.selectIndex(0);
    } else if (matchesKey(data, Key.end)) {
      this.selectIndex(this.actions.length - 1);
    } else if (matchesKey(data, Key.tab) || data === "a" || data === "c" || data === "i") {
      this.setFocusTarget("input");
    } else if (matchesKey(data, Key.enter)) {
      this.submit();
    } else {
      const numberIndex = actionNumberIndex(data, this.actions.length);
      if (numberIndex !== undefined) this.selectIndex(numberIndex);
    }
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const safeWidth = Math.max(1, width);
    const contentWidth = Math.max(MIN_CONTENT_WIDTH, safeWidth - GUTTER_WIDTH);
    const lines: string[] = [];
    lines.push(...this.renderHeader(contentWidth));
    lines.push("");
    lines.push(...this.renderSummaryViewport(contentWidth));
    lines.push("");
    lines.push(...this.renderActions(contentWidth));
    lines.push("");
    lines.push(...this.renderInput(contentWidth));
    lines.push(...this.renderFooter(contentWidth));

    const fitted = lines.map((line) => truncateToWidth(line, safeWidth, "", false));
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
    const title = this.style.accent(this.theme.bold("Grillade complete"));
    const docs =
      this.options.docsMode === undefined
        ? ""
        : this.options.docsMode
          ? " • docs on"
          : " • docs off";
    const subtitle = this.style.muted(`Choose a final action${docs}`);
    return [fitLine(`${title} ${subtitle}`, width), this.style.border("─".repeat(width))];
  }

  private renderSummaryViewport(width: number): string[] {
    const summaryLines = this.renderSummary(width);
    this.scrollTop = clampScroll(this.scrollTop, SUMMARY_VIEWPORT_HEIGHT, summaryLines.length);
    const hiddenAbove = this.scrollTop > 0;
    const hiddenBelow = this.scrollTop + SUMMARY_VIEWPORT_HEIGHT < summaryLines.length;
    const title =
      hiddenAbove || hiddenBelow
        ? `Summary ${hiddenAbove ? "▲" : " "}${hiddenBelow ? "▼" : " "}`
        : "Summary";
    return [
      this.style.muted(title),
      ...summaryLines.slice(this.scrollTop, this.scrollTop + SUMMARY_VIEWPORT_HEIGHT),
    ];
  }

  private renderSummary(width: number): string[] {
    const lines: string[] = [];
    lines.push(...wrapSection("Summary", [this.finish.summary], width, this.style));
    lines.push("");
    lines.push(...wrapSection("Decisions", this.finish.decisions, width, this.style));
    lines.push("");
    lines.push(
      ...wrapSection(
        "Open questions / risks",
        this.finish.openQuestions ?? [],
        width,
        this.style,
        "None captured.",
      ),
    );
    lines.push("");
    lines.push(
      ...wrapSection(
        "Recommended next action",
        [formatActionLabel(this.finish.recommendedNextAction)],
        width,
        this.style,
      ),
    );
    if (this.finish.docsProposalSummaries?.length) {
      lines.push("");
      lines.push(
        ...wrapSection("Docs opportunities", this.finish.docsProposalSummaries, width, this.style),
      );
    }
    return lines.map((line) => fitLine(line, width));
  }

  private renderActions(width: number): string[] {
    const lines = [this.style.muted("Final actions")];
    for (const [index, action] of this.actions.entries()) {
      const selected = index === this.selectedIndex;
      const recommended = action.id === this.finish.recommendedNextAction;
      const marker = selected ? this.style.accent("▶") : " ";
      const label = selected ? this.style.strong(action.label) : action.label;
      const suffix = recommended ? this.style.recommended(" ★ recommended") : "";
      lines.push(fitLine(`${marker} ${index + 1}. ${label}${suffix}`, width));
      if (action.description) {
        for (const line of wrapTextWithAnsi(action.description, Math.max(1, width - 5))) {
          lines.push(fitLine(`     ${this.style.dim(line)}`, width));
        }
      }
    }
    return lines;
  }

  private renderInput(width: number): string[] {
    const selected = this.actions[this.selectedIndex];
    const labelText =
      selected?.id === "continue_grilling"
        ? "Optional steering for more grilling"
        : "Optional note / details for the selected action";
    const label =
      this.focusTarget === "input" ? this.style.accent(labelText) : this.style.muted(labelText);
    const inputWidth = Math.max(1, width - 2);
    const renderedInput = this.input.render(inputWidth)[0] ?? "";
    return [
      fitLine(label, width),
      fitLine(
        `${this.focusTarget === "input" ? this.style.accent(">") : this.style.dim(">")} ${renderedInput}`,
        width,
      ),
    ];
  }

  private renderFooter(width: number): string[] {
    return [
      this.style.border("─".repeat(width)),
      fitLine(
        this.style.dim(
          `↑↓ navigate • PgUp/PgDn summary • 1–${this.actions.length} jump • Enter choose • Tab/a/c add details`,
        ),
        width,
      ),
    ];
  }

  private moveSelection(delta: number): void {
    this.selectIndex(this.selectedIndex + delta);
  }

  private scrollSummary(delta: number): void {
    this.scrollTop = Math.max(0, this.scrollTop + delta);
    this.invalidateAndRender();
  }

  private selectIndex(index: number): void {
    const next = Math.max(0, Math.min(this.actions.length - 1, index));
    if (next === this.selectedIndex && this.focusTarget === "actions") return;
    this.selectedIndex = next;
    this.setFocusTarget("actions");
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

  private submit(): void {
    const action = this.actions[this.selectedIndex];
    if (!action) return;
    const text = this.input.getValue().trim();
    this.done({
      actionId: action.id,
      ...(text ? { steering: text } : {}),
      selectedAt: new Date().toISOString(),
    });
  }

  private invalidateAndRender(): void {
    this.invalidate();
    this.options.onRenderNeeded?.();
  }
}

function normalizeFinalActions(actions: readonly GrilladeFinalAction[]): GrilladeFinalAction[] {
  const overrides = new Map(actions.map((action) => [action.id, action]));
  return GRILLADE_FINAL_ACTION_IDS.map((id) => {
    const action = { ...DEFAULT_ACTIONS[id], ...overrides.get(id), id };
    if (id === "create_update_docs") action.label = DEFAULT_ACTIONS.create_update_docs.label;
    return action;
  });
}

function wrapSection(
  title: string,
  items: readonly string[],
  width: number,
  style: GrilladeUiStyle,
  emptyText?: string,
): string[] {
  const lines = [style.strong(title)];
  const content = items.length > 0 ? items : emptyText ? [emptyText] : [];
  for (const item of content) {
    const prefix = items.length === 1 && title === "Summary" ? "  " : "  • ";
    const nextPrefix = "    ";
    const firstWidth = Math.max(1, width - visibleWidth(prefix));
    const nextWidth = Math.max(1, width - visibleWidth(nextPrefix));
    const wrapped = wrapTextWithAnsi(item, firstWidth);
    for (const [index, line] of wrapped.entries()) {
      if (index === 0) lines.push(`${prefix}${line}`);
      else
        for (const continued of wrapTextWithAnsi(line, nextWidth))
          lines.push(`${nextPrefix}${continued}`);
    }
  }
  return lines;
}

function formatActionLabel(actionId: GrilladeFinalActionId): string {
  return DEFAULT_ACTIONS[actionId].label;
}

function fitLine(line: string, width: number): string {
  return truncateToWidth(line, width, "", false);
}

function actionNumberIndex(data: string, actionCount: number): number | undefined {
  if (!/^[1-9]$/.test(data)) return undefined;
  const index = Number.parseInt(data, 10) - 1;
  return index >= 0 && index < actionCount ? index : undefined;
}

function clampScroll(scrollTop: number, viewportHeight: number, totalLines: number): number {
  return Math.max(0, Math.min(Math.max(0, totalLines - viewportHeight), scrollTop));
}
