import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  aggregateUsage,
  buildChildArgs,
  CHILD_ENV_FLAG,
  type ChildResult,
  getDisplayItems,
  getFinalOutput,
  getResultOutput,
  isFailed,
  MAX_CONCURRENCY,
  MAX_TASKS,
  mapWithConcurrencyLimit,
  newChildResult,
  truncateOutput,
  type UsageStats,
} from "./core.ts";
import { runChild } from "./run.ts";

const COLLAPSED_ITEM_COUNT = 5;

interface SubagentDetails {
  results: ChildResult[];
}

const TaskItem = Type.Object({
  prompt: Type.String({ description: "Complete, self-contained task for the child agent" }),
  label: Type.Optional(Type.String({ description: "Short name shown in the UI" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
});

const Params = Type.Object({
  tasks: Type.Array(TaskItem, {
    description: `One or more tasks. Tasks run in parallel (max ${MAX_TASKS}, ${MAX_CONCURRENCY} at once).`,
    minItems: 1,
  }),
  history: Type.Optional(
    StringEnum(["none", "fork"] as const, {
      description:
        'Conversation history for each child. "none" (default): fresh context. "fork": child starts from a copy of this conversation.',
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model pattern for children (default: current default)" }),
  ),
  thinking: Type.Optional(Type.String({ description: "Thinking level for children" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist for children" })),
});

export default function (pi: ExtensionAPI) {
  // Recursion guard: a child never gets this tool.
  if (process.env[CHILD_ENV_FLAG]) return;

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run headless child pi agents with isolated context. Each task is one prompt; several tasks run in parallel. " +
      'Use history "fork" to give children the current conversation. Only the final answer of each child returns. ' +
      "Children that edit files must not touch the same files.",
    promptSnippet:
      "Delegate self-contained tasks to headless child agents (parallel, optional history fork)",
    parameters: Params,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.tasks.length > MAX_TASKS) {
        return {
          content: [
            { type: "text", text: `Too many tasks (${params.tasks.length}). Max is ${MAX_TASKS}.` },
          ],
          details: { results: [] } satisfies SubagentDetails,
          isError: true,
        };
      }

      let forkSessionFile: string | undefined;
      let note = "";
      if (params.history === "fork") {
        forkSessionFile = ctx.sessionManager.getSessionFile();
        if (!forkSessionFile)
          note = "Note: no session file to fork. Children ran with fresh context.\n\n";
      }
      const sessionDir = forkSessionFile
        ? await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"))
        : undefined;

      const results = params.tasks.map((task, i) =>
        newChildResult(task.label || `task ${i + 1}`, task.prompt),
      );
      const emit = () =>
        onUpdate?.({
          content: [
            {
              type: "text",
              text: `${results.filter((r) => r.exitCode !== -1).length}/${results.length} done`,
            },
          ],
          details: { results: [...results] } satisfies SubagentDetails,
        });

      try {
        await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const result = results[index] as ChildResult;
          const args = buildChildArgs({
            prompt: task.prompt,
            model: params.model,
            thinking: params.thinking,
            tools: params.tools,
            forkSessionFile,
            sessionDir,
          });
          await runChild(result, args, task.cwd ?? ctx.cwd, signal, emit);
          emit();
        });
      } finally {
        if (sessionDir) await fs.promises.rm(sessionDir, { recursive: true, force: true });
      }

      const ok = results.filter((r) => !isFailed(r)).length;
      const sections = results.map((r) => {
        const status = isFailed(r)
          ? `failed${r.stopReason ? ` (${r.stopReason})` : ""}`
          : "completed";
        return `### [${r.label}] ${status}\n\n${truncateOutput(getResultOutput(r))}`;
      });
      return {
        content: [
          {
            type: "text",
            text: `${note}${ok}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}`,
          },
        ],
        details: { results } satisfies SubagentDetails,
        isError: ok < results.length,
      };
    },

    renderCall(args, theme) {
      const tasks = args.tasks ?? [];
      let text =
        theme.fg("toolTitle", theme.bold("subagent ")) +
        theme.fg("accent", `${tasks.length} task${tasks.length === 1 ? "" : "s"}`) +
        theme.fg("muted", ` [history: ${args.history ?? "none"}]`);
      for (const task of tasks.slice(0, 3)) {
        const preview = task.prompt.length > 70 ? `${task.prompt.slice(0, 70)}...` : task.prompt;
        text += `\n  ${theme.fg("dim", preview)}`;
      }
      if (tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${tasks.length - 3} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details || details.results.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
      }
      const fg = theme.fg.bind(theme) as (color: string, text: string) => string;
      const running = details.results.some((r) => r.exitCode === -1);
      const failed = details.results.some(isFailed);
      const icon = running ? fg("warning", "⏳") : failed ? fg("error", "✗") : fg("success", "✓");
      const done = details.results.filter((r) => r.exitCode !== -1).length;
      const header = `${icon} ${fg("toolTitle", theme.bold("subagent "))}${fg("accent", `${done}/${details.results.length}`)}`;
      const total = formatUsage(aggregateUsage(details.results));

      const container = new Container();
      container.addChild(new Text(header, 0, 0));
      for (const r of details.results) {
        const rIcon =
          r.exitCode === -1
            ? fg("warning", "⏳")
            : isFailed(r)
              ? fg("error", "✗")
              : fg("success", "✓");
        container.addChild(new Spacer(1));
        container.addChild(
          new Text(`${fg("muted", "─── ")}${fg("accent", r.label)} ${rIcon}`, 0, 0),
        );
        const items = getDisplayItems(r.messages);
        const calls = items.filter((i) => i.type === "toolCall");
        const shown = expanded ? calls : calls.slice(-COLLAPSED_ITEM_COUNT);
        if (calls.length > shown.length) {
          container.addChild(
            new Text(fg("muted", `... ${calls.length - shown.length} earlier calls`), 0, 0),
          );
        }
        for (const call of shown) {
          container.addChild(
            new Text(fg("muted", "→ ") + formatToolCall(call.name, call.args, fg), 0, 0),
          );
        }
        const final = getFinalOutput(r.messages).trim();
        if (r.exitCode === -1 && calls.length === 0 && !final) {
          container.addChild(new Text(fg("muted", "(running...)"), 0, 0));
        } else if (final && r.exitCode !== -1) {
          if (expanded) container.addChild(new Markdown(final, 0, 0, getMarkdownTheme()));
          else
            container.addChild(
              new Text(fg("toolOutput", final.split("\n").slice(0, 3).join("\n")), 0, 0),
            );
        }
        if (isFailed(r))
          container.addChild(new Text(fg("error", getResultOutput(r).slice(0, 300)), 0, 0));
        const usage = formatUsage(r.usage, r.model);
        if (usage && r.exitCode !== -1) container.addChild(new Text(fg("dim", usage), 0, 0));
      }
      if (!running && total) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(fg("dim", `Total: ${total}`), 0, 0));
      }
      if (!expanded) container.addChild(new Text(fg("muted", "(Ctrl+O to expand)"), 0, 0));
      return container;
    },
  });
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsage(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  name: string,
  args: Record<string, unknown>,
  fg: (color: string, text: string) => string,
): string {
  const short = (p: string) =>
    p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;
  const str = (v: unknown, fallback = "...") => (typeof v === "string" ? v : fallback);
  switch (name) {
    case "bash": {
      const command = str(args["command"]);
      return (
        fg("muted", "$ ") +
        fg("toolOutput", command.length > 60 ? `${command.slice(0, 60)}...` : command)
      );
    }
    case "read": {
      const offset = args["offset"];
      const limit = args["limit"];
      const range =
        typeof offset === "number"
          ? `:${offset}${typeof limit === "number" ? `-${offset + limit - 1}` : ""}`
          : "";
      return (
        fg("muted", "read ") +
        fg("accent", short(str(args["file_path"] ?? args["path"]))) +
        (range ? fg("warning", range) : "")
      );
    }
    case "write":
    case "edit":
      return fg("muted", `${name} `) + fg("accent", short(str(args["file_path"] ?? args["path"])));
    default: {
      const json = JSON.stringify(args);
      return (
        fg("accent", name) + fg("dim", ` ${json.length > 50 ? `${json.slice(0, 50)}...` : json}`)
      );
    }
  }
}
