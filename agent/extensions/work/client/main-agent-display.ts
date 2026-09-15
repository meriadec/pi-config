import type { MainAgentActivity } from "../domain/index.ts";

interface ShimmerPalette {
  readonly base: string;
  readonly sweep: readonly string[];
}

const THINKING_SHIMMER: ShimmerPalette = {
  base: "\x1b[38;5;146m",
  sweep: ["\x1b[38;5;231m", "\x1b[38;5;189m", "\x1b[38;5;183m"],
};
const TRACKING_PR_SHIMMER: ShimmerPalette = {
  base: "\x1b[38;5;109m",
  sweep: ["\x1b[38;5;195m", "\x1b[38;5;159m", "\x1b[38;5;117m"],
};
const SHIMMER_TRAIL = 4;

/** Shared loop boundary for thinking, delegated-thinking, and Tracking PR labels. */
export const MAIN_AGENT_SHIMMER_PERIOD = 180;

export function isShimmeringMainAgentActivity(activity: MainAgentActivity | undefined): boolean {
  return activity === "thinking" || activity === "thinking-sub" || activity === "tracking-pr";
}

/** Maps control-plane activity to its exact user-visible label. */
export function mainAgentDisplayLabel(activity: MainAgentActivity): string {
  return activity === "thinking-sub" ? "thinking (sub)" : activity;
}

/** Renders one activity with the previous distinct animation palettes. */
export function renderMainAgentActivity(activity: MainAgentActivity, phase: number): string {
  const label = mainAgentDisplayLabel(activity);
  if (activity === "thinking" || activity === "thinking-sub") {
    return shimmer(label, phase, THINKING_SHIMMER);
  }
  if (activity === "tracking-pr") return shimmer(label, phase, TRACKING_PR_SHIMMER);
  return label;
}

function shimmer(text: string, phase: number, palette: ShimmerPalette): string {
  const characters = [...text];
  const head = phase % (characters.length + SHIMMER_TRAIL);
  return characters
    .map((character, index) => {
      const distance = head - index;
      const colour =
        distance >= 0 && distance < palette.sweep.length ? palette.sweep[distance] : palette.base;
      return `${colour}${character}\x1b[39m`;
    })
    .join("");
}
