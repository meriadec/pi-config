import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
} from "@earendil-works/pi-tui";

const FULLSCREEN_FILL_LINES = 200;
const MIN_CONTENT_WIDTH = 32;

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
        tui: unknown,
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
      (_tui, theme, _keybindings, done) => {
        state = { done };
        activePreparingOverlay = state;
        return new PreparingScreen(theme, message);
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
  private cachedLines: string[] | undefined;
  private readonly theme: Theme;
  private readonly message: string;

  constructor(theme: Theme, message: string) {
    this.theme = theme;
    this.message = message;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

    const safeWidth = Math.max(MIN_CONTENT_WIDTH, width);
    const blank = " ".repeat(safeWidth);
    const lines = Array.from({ length: FULLSCREEN_FILL_LINES }, () => blank);
    const accent = (text: string) => this.theme.fg("accent", text);
    const muted = (text: string) => this.theme.fg("muted", text);
    const dim = (text: string) => this.theme.fg("dim", text);

    lines[1] = paintLine(
      `${accent(this.theme.bold("Grillade"))} ${muted("interview mode")}`,
      safeWidth,
    );
    lines[2] = this.theme.fg("border", "═".repeat(safeWidth));
    lines[5] = paintLine(accent("●") + " " + this.theme.bold(this.message), safeWidth);
    lines[7] = paintLine(
      dim(
        "The question UI will replace this screen as soon as the first structured question is ready.",
      ),
      safeWidth,
    );

    this.cachedWidth = width;
    this.cachedLines = lines.map((line) => truncateToWidth(line, width, "", false));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

function paintLine(content: string, width: number): string {
  const fitted = truncateToWidth(content, width, "", false);
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}
