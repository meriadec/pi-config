import type { Theme } from "@earendil-works/pi-coding-agent";
import type { GrilladeConfidence } from "../protocol.ts";

export type GrilladeUiStyle = {
  accent(text: string): string;
  border(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  selected(text: string): string;
  recommended(text: string): string;
  confidence(level: GrilladeConfidence, text: string): string;
  strong(text: string): string;
  warning(text: string): string;
};

export function getGrilladeUiStyle(theme: Theme): GrilladeUiStyle {
  return {
    accent: (text) => theme.fg("accent", text),
    border: (text) => theme.fg("border", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    selected: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
    recommended: (text) => theme.fg("success", text),
    confidence: (level, text) => {
      switch (level) {
        case "high":
          return theme.fg("success", text);
        case "medium":
          return theme.fg("warning", text);
        case "low":
          return theme.fg("muted", text);
      }
    },
    strong: (text) => theme.bold(text),
    warning: (text) => theme.fg("warning", text),
  };
}
