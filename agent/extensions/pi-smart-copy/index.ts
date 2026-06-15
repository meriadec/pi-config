import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  buildCodeCandidate,
  buildFullAnswerCandidate,
  countContentLines,
  extractSimpleCodeBlocks,
  pluralize,
  type CopyCandidate,
} from "./src/extract.ts";
import { copyTextToClipboard } from "./src/clipboard.ts";

export default function smartCopyExtension(pi: ExtensionAPI): void {
  pi.registerCommand("smart-copy", {
    description: "Copy a code block from the last assistant answer",
    handler: runSmartCopy,
  });

  pi.registerCommand("c", {
    description: "Copy a code block from the last assistant answer",
    handler: runSmartCopy,
  });
}

async function runSmartCopy(_args: string, ctx: ExtensionCommandContext): Promise<void> {
  await ctx.waitForIdle();

  const text = getLastAssistantText(ctx.sessionManager.getBranch());
  if (text === undefined || text.length === 0) {
    ctx.ui.notify("No assistant text to copy yet.", "error");
    return;
  }

  const blocks = extractSimpleCodeBlocks(text);

  if (blocks.length === 0) {
    await copyCandidate(ctx, buildFullAnswerCandidate(text), "Copied full assistant answer to clipboard");
    return;
  }

  if (blocks.length === 1) {
    const block = blocks[0]!;
    await copyCandidate(
      ctx,
      buildCodeCandidate(block),
      `Copied code block #${block.index} (${pluralize(countContentLines(block.content), "line")}) to clipboard`,
    );
    return;
  }

  const candidates = [...blocks.map(buildCodeCandidate), buildFullAnswerCandidate(text)];
  const selectedIndex = await selectCandidate(ctx, candidates);
  if (selectedIndex === null) return;

  const candidate = candidates[selectedIndex];
  if (!candidate) return;

  await copyCandidate(ctx, candidate, `Copied ${candidate.label} to clipboard`);
}

function getLastAssistantText(branch: SessionEntry[]): string | undefined {
  for (const entry of branch.slice().reverse()) {
    if (entry.type !== "message") continue;
    if (entry.message.role !== "assistant") continue;

    let text = "";
    const content = entry.message.content;
    if (!Array.isArray(content)) return undefined;

    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
      }
    }

    return text;
  }

  return undefined;
}

async function copyCandidate(
  ctx: ExtensionCommandContext,
  candidate: CopyCandidate,
  successMessage: string,
): Promise<void> {
  try {
    await copyTextToClipboard(candidate.content);
    ctx.ui.notify(successMessage, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to copy to clipboard: ${message}`, "error");
  }
}

async function selectCandidate(ctx: ExtensionCommandContext, candidates: CopyCandidate[]): Promise<number | null> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("Multiple code blocks found; copying the first one because the TUI selector is unavailable.", "warning");
    return 0;
  }

  return await ctx.ui.custom<number | null>((tui, theme, _keybindings, done) => {
    let selected = 0;

    const component: Component = {
      render(width: number): string[] {
        const lines: string[] = [];
        lines.push(truncateToWidth(theme.fg("accent", theme.bold("Smart Copy")), width));
        lines.push(truncateToWidth(theme.fg("dim", "Select a code block to copy"), width));
        lines.push("");

        for (let index = 0; index < candidates.length; index += 1) {
          const candidate = candidates[index]!;
          const selectedPrefix = index === selected ? "› " : "  ";
          const label = candidate.label;
          const preview = candidate.description ? `  ${candidate.description}` : "";
          const rawLine = `${selectedPrefix}${label}${preview}`;
          const styledLine =
            index === selected
              ? theme.bg("selectedBg", theme.fg("accent", rawLine))
              : theme.fg(candidate.kind === "full" ? "muted" : "text", rawLine);
          lines.push(truncateToWidth(styledLine, width));
        }

        lines.push("");
        lines.push(truncateToWidth(theme.fg("dim", "↑↓ navigate • enter copy • esc cancel"), width));
        return lines;
      },

      handleInput(data: string): void {
        if (matchesKey(data, Key.up)) {
          selected = Math.max(0, selected - 1);
          tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.down)) {
          selected = Math.min(candidates.length - 1, selected + 1);
          tui.requestRender();
          return;
        }

        if (matchesKey(data, Key.enter)) {
          done(selected);
          return;
        }

        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
          done(null);
        }
      },

      invalidate(): void {},
    };

    return component;
  });
}
