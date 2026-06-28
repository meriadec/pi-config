import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

const FALLBACK_VIEWPORT_HEIGHT = 24;
const MIN_CONTENT_WIDTH = 32;
const CARD_MAX_WIDTH = 68;
const CARD_MIN_WIDTH = 34;

export const GRILLADE_FULLSCREEN_OVERLAY_OPTIONS = {
  anchor: "top-left",
  row: 0,
  col: 0,
  width: "100%",
  maxHeight: "100%",
  margin: 0,
} as const;

export type GrilladePreparingUiContext = {
  mode: string;
  hasUI: boolean;
  ui: {
    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: unknown,
        done: (result: T) => void,
      ) => Component,
      options?: {
        overlay?: boolean;
        overlayOptions?: typeof GRILLADE_FULLSCREEN_OVERLAY_OPTIONS;
        onHandle?: (handle: OverlayHandle) => void;
      },
    ): Promise<T>;
  };
};

type PreparingOverlayState = {
  done: (result: null) => void;
  handle?: OverlayHandle;
};

let activePreparingOverlay: PreparingOverlayState | undefined;

export function showGrilladePreparingScreen(
  ctx: GrilladePreparingUiContext,
  message = "Preparing first Grillade question…",
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  closeGrilladePreparingScreen();

  let state: PreparingOverlayState | undefined;
  void ctx.ui
    .custom<null>(
      (tui, theme, _keybindings, done) => {
        state = { done };
        activePreparingOverlay = state;
        return new PreparingScreen(theme, message, () => tui.terminal.rows);
      },
      {
        overlay: true,
        overlayOptions: GRILLADE_FULLSCREEN_OVERLAY_OPTIONS,
        onHandle: (handle) => {
          if (state) state.handle = handle;
        },
      },
    )
    .finally(() => {
      if (state && activePreparingOverlay === state) activePreparingOverlay = undefined;
    });
}

export function closeGrilladePreparingScreen(): void {
  const overlay = activePreparingOverlay;
  if (!overlay) return;
  activePreparingOverlay = undefined;
  overlay.done(null);
}

class PreparingScreen implements Component {
  private cachedWidth: number | undefined;
  private cachedHeight: number | undefined;
  private cachedLines: string[] | undefined;
  private readonly theme: Theme;
  private readonly message: string;
  private readonly getViewportHeight: () => number;

  constructor(theme: Theme, message: string, getViewportHeight: () => number) {
    this.theme = theme;
    this.message = message;
    this.getViewportHeight = getViewportHeight;
  }

  render(width: number): string[] {
    const viewportHeight = Math.max(1, this.getViewportHeight() || FALLBACK_VIEWPORT_HEIGHT);
    if (this.cachedWidth === width && this.cachedHeight === viewportHeight && this.cachedLines) {
      return this.cachedLines;
    }

    const safeWidth = Math.max(MIN_CONTENT_WIDTH, width);
    const blank = " ".repeat(safeWidth);
    const lines = Array.from({ length: viewportHeight }, () => blank);
    const card = this.renderCenteredCard(safeWidth);
    const startRow = Math.max(0, Math.floor((viewportHeight - card.length) / 2));
    for (const [index, line] of card.entries()) {
      lines[startRow + index] = centerLine(line, safeWidth);
    }

    this.cachedWidth = width;
    this.cachedHeight = viewportHeight;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width, "", false));
    return this.cachedLines;
  }

  private renderCenteredCard(width: number): string[] {
    const cardWidth = Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, width - 8));
    const innerWidth = Math.max(1, cardWidth - 4);
    const accent = (text: string) => this.theme.fg("accent", text);
    const muted = (text: string) => this.theme.fg("muted", text);
    const dim = (text: string) => this.theme.fg("dim", text);
    const border = (text: string) => this.theme.fg("border", text);
    const title = accent(this.theme.bold("Grillade"));
    const subtitle = muted("interview mode");
    const message = accent("●") + " " + this.theme.bold(this.message);
    const hint = dim("The first structured question will appear here automatically.");

    return [
      border(`╭${"─".repeat(Math.max(0, cardWidth - 2))}╮`),
      cardLine(`${title} ${subtitle}`, cardWidth),
      cardLine("", cardWidth),
      cardLine(message, cardWidth),
      cardLine("", cardWidth),
      ...wrapPlain(hint, innerWidth).map((line) => cardLine(line, cardWidth)),
      border(`╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`),
    ];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }
}

function cardLine(content: string, width: number): string {
  const innerWidth = Math.max(0, width - 4);
  const fitted = truncateToWidth(content, innerWidth, "", false);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)));
  return `│ ${fitted}${padding} │`;
}

function centerLine(content: string, width: number): string {
  const fitted = truncateToWidth(content, width, "", false);
  const left = Math.max(0, Math.floor((width - visibleWidth(fitted)) / 2));
  return `${" ".repeat(left)}${fitted}${" ".repeat(Math.max(0, width - left - visibleWidth(fitted)))}`;
}

function wrapPlain(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (visibleWidth(next) <= width) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
