import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { agentGitConfigGlobal } from "./lib/agent-git-config.ts";

const STATUS_KEY = "ralph-loop";
const DEFAULT_MAX_ATTEMPTS = 2;
const TERMINAL_STATUSES = new Set(["done", "completed", "closed"]);
const OUTCOME_VALUES = ["completed", "skipped", "needs_human", "blocked"] as const;
const ISSUE_CONTEXT_MARKER_PREFIX = "Ralph Loop issue marker:";

type RalphOutcome = (typeof OUTCOME_VALUES)[number];

type IssueRef = {
  path: string;
  relPath: string;
  title: string;
  status?: string | undefined;
  number?: number | undefined;
};

type LoopState = {
  id: string;
  cwd: string;
  repoRoot: string;
  scratchDir: string;
  issues: IssueRef[];
  queue: IssueRef[];
  current?: IssueRef | undefined;
  currentAttempt: number;
  startedIssues: number;
  completed: IssueRef[];
  skipped: IssueRef[];
  maxIssues: number;
  maxAttempts: number;
  allowDirty: boolean;
  includeDone: boolean;
  stoppedReason?: string | undefined;
  startedAt: number;
};

type StartOptions = {
  selectors: string[];
  maxIssues?: number;
  maxAttempts: number;
  allowDirty: boolean;
  includeDone: boolean;
};

type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

let activeLoop: LoopState | undefined;

function helpText(): string {
  return [
    "Usage:",
    "  /ralph-loop start [options] <.scratch issue selectors>",
    "  /ralph-loop status",
    "  /ralph-loop resume",
    "  /ralph-loop stop",
    "  /ralph-loop reset",
    "",
    "Issue selectors are resolved inside the current repo's .scratch/ directory.",
    "Examples:",
    "  /ralph-loop start les-vault:1-3",
    "  /ralph-loop start les-vault:1,3,5-7",
    "  /ralph-loop start .scratch/les-vault/issues/01-exposure-foundation.md",
    "  /ralph-loop start .scratch/les-vault/issues:1-3",
    "  /ralph-loop start .scratch/les-vault/issues",
    "  /ralph-loop start from .scratch/foo-bar, do in order: 08 → 09 → 11 → 10 → 12",
    "",
    "Options:",
    `  --max-attempts <n>        Commit-fix attempts per issue when pre-commit hooks reject (default ${DEFAULT_MAX_ATTEMPTS})`,
    "  --max-issues <n>          Cap how many selected non-done issues are attempted",
    "  --include-done            Do not pre-filter Status: done/completed/closed issue files",
    "  --allow-dirty             Start even if git status is dirty",
  ].join("\n");
}

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

function parsePositiveInt(raw: string | undefined, name: string): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
  return value;
}

function normalizeNaturalOrderArgs(rawArgs: string): string {
  const match = rawArgs.match(/^(.*?)\bfrom\s+(.+?),?\s+do\s+in\s+order:\s*(.+)$/i);
  if (!match) return rawArgs;

  const prefix = match[1]?.trim() ?? "";
  const base = match[2]?.trim().replace(/,$/, "") ?? "";
  const order = match[3] ?? "";
  const numbers = order
    .split(/(?:\s*(?:→|->|,|;)\s*)|\s+/)
    .map((part) => part.trim().replace(/^#/, ""))
    .filter(Boolean);

  if (!base || numbers.length === 0 || numbers.some((part) => !/^\d+$/.test(part))) return rawArgs;
  return [prefix, `${base}:${numbers.join(",")}`].filter(Boolean).join(" ");
}

function parseStartOptions(rawArgs: string): StartOptions {
  const tokens = tokenizeArgs(normalizeNaturalOrderArgs(rawArgs));
  const options: StartOptions = {
    selectors: [],
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    allowDirty: false,
    includeDone: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const readValue = (name: string, inline?: string) => {
      if (inline !== undefined) return inline;
      const next = tokens[++i];
      if (!next) throw new Error(`${name} requires a value.`);
      return next;
    };

    if (token === "--allow-dirty") {
      options.allowDirty = true;
      continue;
    }
    if (token === "--include-done") {
      options.includeDone = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      throw new Error(helpText());
    }

    const optionMatch = token.match(/^(--[^=]+)(?:=(.*))?$/);
    if (optionMatch) {
      const [, name, inline] = optionMatch;
      switch (name) {
        case "--max-issues":
          options.maxIssues = parsePositiveInt(readValue(name, inline), name);
          continue;
        case "--max-attempts":
          options.maxAttempts = parsePositiveInt(readValue(name, inline), name);
          continue;
        default:
          throw new Error(`Unknown ralph-loop option: ${name}`);
      }
    }

    options.selectors.push(token);
  }

  if (options.selectors.length === 0) {
    throw new Error("No .scratch issue selector provided.\n\n" + helpText());
  }

  return options;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}

function toRepoRelative(repoRoot: string, filePath: string): string {
  return relative(repoRoot, filePath).split(sep).join("/");
}

function splitSelectorRange(selector: string): { base: string; range?: string } {
  const colon = selector.lastIndexOf(":");
  if (colon === -1) return { base: selector };
  const suffix = selector.slice(colon + 1).trim();
  if (!/^[\d,\-\s]+$/.test(suffix)) return { base: selector };
  return { base: selector.slice(0, colon), range: suffix };
}

function expandRange(range: string): number[] {
  const values = new Set<number>();
  for (const part of range.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`Invalid issue range segment: ${trimmed}`);
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (end < start) throw new Error(`Invalid descending issue range: ${trimmed}`);
    for (let value = start; value <= end; value++) values.add(value);
  }
  return [...values];
}

function numericPrefix(fileName: string): number | undefined {
  const match = fileName.match(/^(\d+)(?:[-_\s].*)?\.md$/i);
  return match ? Number(match[1]) : undefined;
}

async function listIssueFiles(directory: string): Promise<IssueRef[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => join(directory, entry.name));
  files.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));
  return Promise.all(files.map((file) => readIssue(file)));
}

async function issueDirectoryFor(basePath: string): Promise<string> {
  const info = await stat(basePath).catch(() => undefined);
  if (!info) throw new Error(`Issue selector does not exist: ${basePath}`);
  if (!info.isDirectory())
    throw new Error(`Issue range selector must point to a directory: ${basePath}`);

  const nestedIssues = join(basePath, "issues");
  if (await pathExists(nestedIssues)) {
    const nestedInfo = await stat(nestedIssues);
    if (nestedInfo.isDirectory()) return nestedIssues;
  }
  return basePath;
}

async function readIssue(filePath: string): Promise<IssueRef> {
  const text = await readFile(filePath, "utf8");
  const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(filePath, ".md");
  const status = text.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
  return {
    path: filePath,
    relPath: filePath,
    title,
    status,
    number: numericPrefix(basename(filePath)),
  };
}

async function resolveBasePath(
  base: string,
  repoRoot: string,
  scratchDir: string,
): Promise<string> {
  if (!base.trim()) throw new Error("Empty issue selector base.");

  const candidates: string[] = [];
  if (isAbsolute(base)) {
    candidates.push(resolve(base));
  } else {
    candidates.push(resolve(repoRoot, base));
    if (!base.startsWith(`.scratch/`) && base !== ".scratch") {
      candidates.push(resolve(scratchDir, base));
      if (!base.includes("/")) candidates.push(resolve(scratchDir, base, "issues"));
    }
  }

  let existingOutsideScratch: string | undefined;
  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) continue;
    if (isInside(candidate, scratchDir)) return candidate;
    existingOutsideScratch = candidate;
  }

  if (existingOutsideScratch) throw new Error(`Issue selector escapes .scratch/: ${base}`);
  throw new Error(`Could not resolve issue selector inside .scratch/: ${base}`);
}

async function resolveSelector(
  selector: string,
  repoRoot: string,
  scratchDir: string,
): Promise<IssueRef[]> {
  const { base, range } = splitSelectorRange(selector);
  const basePath = await resolveBasePath(base, repoRoot, scratchDir);
  if (!isInside(basePath, scratchDir)) {
    throw new Error(`Issue selector escapes .scratch/: ${selector}`);
  }

  const info = await stat(basePath);
  let issues: IssueRef[];
  if (range) {
    const issueDir = await issueDirectoryFor(basePath);
    if (!isInside(issueDir, scratchDir))
      throw new Error(`Issue selector escapes .scratch/: ${selector}`);
    const available = await listIssueFiles(issueDir);
    const byNumber = new Map<number, IssueRef[]>();
    for (const issue of available) {
      if (issue.number === undefined) continue;
      const group = byNumber.get(issue.number) ?? [];
      group.push(issue);
      byNumber.set(issue.number, group);
    }

    issues = [];
    for (const number of expandRange(range)) {
      const matches = byNumber.get(number) ?? [];
      if (matches.length === 0)
        throw new Error(`No .scratch issue file with numeric prefix ${number} in ${issueDir}`);
      if (matches.length > 1) {
        throw new Error(
          `Multiple .scratch issue files with numeric prefix ${number} in ${issueDir}`,
        );
      }
      issues.push(matches[0]!);
    }
  } else if (info.isDirectory()) {
    const issueDir = await issueDirectoryFor(basePath);
    issues = await listIssueFiles(issueDir);
  } else if (info.isFile() && basePath.toLowerCase().endsWith(".md")) {
    issues = [await readIssue(basePath)];
  } else {
    throw new Error(`Issue selector must resolve to a markdown file or directory: ${selector}`);
  }

  return issues.map((issue) => ({ ...issue, relPath: toRepoRelative(repoRoot, issue.path) }));
}

async function resolveIssueSelectors(
  selectors: string[],
  repoRoot: string,
  scratchDir: string,
): Promise<IssueRef[]> {
  const issues: IssueRef[] = [];
  const seen = new Set<string>();
  for (const selector of selectors) {
    for (const issue of await resolveSelector(selector, repoRoot, scratchDir)) {
      if (seen.has(issue.path)) continue;
      seen.add(issue.path);
      issues.push(issue);
    }
  }
  return issues;
}

function isTerminalStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

async function repoRoot(pi: ExtensionAPI): Promise<string> {
  const result = (await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    timeout: 10_000,
  })) as CommandResult;
  if (result.code !== 0) throw new Error("ralph-loop must run inside a git repository.");
  return result.stdout.trim();
}

function gitArgs(repoRootPath: string, args: string[]): string[] {
  return ["-C", repoRootPath, ...args];
}

async function gitStatus(pi: ExtensionAPI, repoRootPath: string): Promise<string> {
  const result = (await pi.exec("git", gitArgs(repoRootPath, ["status", "--porcelain"]), {
    timeout: 10_000,
  })) as CommandResult;
  if (result.code !== 0) throw new Error(result.stderr.trim() || "git status failed");
  return result.stdout.trim();
}

async function ensureNoMergeState(pi: ExtensionAPI, repoRootPath: string): Promise<void> {
  const unmerged = (await pi.exec(
    "git",
    gitArgs(repoRootPath, ["diff", "--name-only", "--diff-filter=U"]),
    { timeout: 10_000 },
  )) as CommandResult;
  if (unmerged.code !== 0)
    throw new Error(unmerged.stderr.trim() || "Failed to inspect unmerged git paths.");
  if (unmerged.stdout.trim())
    throw new Error(`Unmerged git paths exist:\n${unmerged.stdout.trim()}`);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function truncateText(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]`;
}

function safeCommitMessage(raw: string | undefined, issue: IssueRef): string {
  const trimmed = raw?.trim();
  if (!trimmed) return `fix: address ${issue.title}`.slice(0, 200);
  const lines = trimmed.split(/\r?\n/).map((line) => line.trimEnd());
  const subject = (lines[0] || `fix: address ${issue.title}`).slice(0, 200);
  return [subject, ...lines.slice(1)].join("\n").trim();
}

async function markIssueDone(issue: IssueRef): Promise<boolean> {
  const current = await readFile(issue.path, "utf8");
  let next: string;
  if (/^Status:\s*.*$/im.test(current)) {
    next = current.replace(/^Status:\s*.*$/im, "Status: done");
  } else {
    const lines = current.split(/\r?\n/);
    const insertAt = lines[0]?.startsWith("#") ? 1 : 0;
    lines.splice(insertAt, 0, "", "Status: done");
    next = lines.join("\n");
  }
  if (next === current) return false;
  await writeFile(issue.path, next, "utf8");
  issue.status = "done";
  return true;
}

async function commitCurrentIssue(
  pi: ExtensionAPI,
  state: LoopState,
  issue: IssueRef,
  commitMessage: string,
  noVerify: boolean,
): Promise<{ ok: boolean; output: string }> {
  const add = (await pi.exec("git", gitArgs(state.repoRoot, ["add", "-A"]), {
    timeout: 60_000,
  })) as CommandResult;
  if (add.code !== 0) throw new Error(add.stderr.trim() || "git add failed");

  const agentGitConfig = agentGitConfigGlobal();
  const noVerifyArg = noVerify ? " --no-verify" : "";
  const commitScript = [
    `export GIT_CONFIG_GLOBAL=${shellQuote(agentGitConfig)}`,
    `git -C ${shellQuote(state.repoRoot)} commit${noVerifyArg} -m ${shellQuote(commitMessage)}`,
  ].join("\n");
  const commit = (await pi.exec("bash", ["-lc", commitScript], {
    timeout: 120_000,
  })) as CommandResult;
  const output = [commit.stdout, commit.stderr].filter(Boolean).join("\n").trim();
  // A non-zero exit here is normally a pre-commit hook rejecting the change.
  // Surface it to the caller so the agent can fix it and retry.
  return {
    ok: commit.code === 0,
    output: output || (commit.code === 0 ? "" : "git commit failed"),
  };
}

function formatIssueLine(issue: IssueRef): string {
  const number = issue.number === undefined ? "" : `#${issue.number} `;
  const status = issue.status ? ` [${issue.status}]` : "";
  return `${number}${issue.relPath}${status} — ${issue.title}`;
}

function formatLoopStatus(state: LoopState): string {
  const current = state.current
    ? `${state.current.relPath} attempt ${state.currentAttempt}/${state.maxAttempts}`
    : "none";
  return [
    `Ralph Loop ${state.stoppedReason ? "stopped" : "running"}`,
    `Current: ${current}`,
    `Started: ${state.startedIssues}/${state.maxIssues}`,
    `Completed: ${state.completed.length}`,
    `Skipped: ${state.skipped.length}`,
    `Remaining: ${state.queue.length}`,
    state.stoppedReason ? `Reason: ${state.stoppedReason}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

type StatusTheme = Pick<Theme, "fg" | "bg">;
type StatusBg =
  | "selectedBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

type StatusContext = {
  ui: {
    setStatus: (key: string, value: string | undefined) => void;
    theme?: StatusTheme | undefined;
  };
};

type StatusPill = {
  label: string;
  value: string;
  labelColor: ThemeColor;
  valueColor?: ThemeColor | undefined;
  bg: StatusBg;
};

function statusLabel(theme: StatusTheme | undefined, pill: StatusPill): string {
  const label = ` ${pill.label} `;
  if (!theme) return `[${pill.label}]`;
  return theme.bg(pill.bg, theme.fg(pill.labelColor, label));
}

function statusValue(theme: StatusTheme | undefined, pill: StatusPill): string {
  if (!theme || !pill.valueColor) return pill.value;
  return theme.fg(pill.valueColor, pill.value);
}

function formatStatusPill(theme: StatusTheme | undefined, pill: StatusPill): string {
  return `${statusLabel(theme, pill)} ${statusValue(theme, pill)}`;
}

function currentStatusValue(state: LoopState): string {
  if (!state.current) return "starting";
  return `${state.current.number ?? basename(state.current.path, ".md")}`;
}

function formatStatusLine(state: LoopState, theme: StatusTheme | undefined): string {
  const stateValue = state.stoppedReason ? "stopped" : "running";
  const stateColor: ThemeColor = state.stoppedReason ? "warning" : "accent";
  const pills: StatusPill[] = [
    {
      label: "ralph",
      value: stateValue,
      labelColor: stateColor,
      valueColor: stateColor,
      bg: state.stoppedReason ? "toolErrorBg" : "toolPendingBg",
    },
    {
      label: "issue",
      value: currentStatusValue(state),
      labelColor: "accent",
      valueColor: state.current ? "text" : "dim",
      bg: "customMessageBg",
    },
    {
      label: "try",
      value: `${state.currentAttempt}/${state.maxAttempts}`,
      labelColor: "muted",
      valueColor: "text",
      bg: "selectedBg",
    },
    {
      label: "done",
      value: `${state.completed.length}`,
      labelColor: "success",
      valueColor: "success",
      bg: "toolSuccessBg",
    },
    {
      label: "skip",
      value: `${state.skipped.length}`,
      labelColor: "warning",
      valueColor: "warning",
      bg: "toolPendingBg",
    },
    {
      label: "left",
      value: `${state.queue.length}`,
      labelColor: "muted",
      valueColor: "text",
      bg: "selectedBg",
    },
  ];

  if (state.stoppedReason) {
    pills.splice(1, 0, {
      label: "reason",
      value: state.stoppedReason.slice(0, 40),
      labelColor: "warning",
      valueColor: "warning",
      bg: "toolErrorBg",
    });
  }

  const separator = theme ? theme.fg("dim", "   ") : "     ";
  return pills.map((pill) => formatStatusPill(theme, pill)).join(separator);
}

function updateStatus(ctx: StatusContext, state?: LoopState) {
  if (!state) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }

  ctx.ui.setStatus(STATUS_KEY, formatStatusLine(state, ctx.ui.theme));
}

function appendState(pi: ExtensionAPI, event: string, data: Record<string, unknown> = {}) {
  try {
    pi.appendEntry("ralph-loop", { event, at: new Date().toISOString(), ...data });
  } catch {
    // State snapshots are best-effort session annotations.
  }
}

function stopLoop(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
      notify?: (message: string, level: "info" | "warning" | "error") => void;
    };
  },
  reason: string,
) {
  if (!activeLoop) return;
  activeLoop.stoppedReason = reason;
  appendState(pi, "stopped", { reason, status: formatLoopStatus(activeLoop) });
  updateStatus(ctx, activeLoop);
  ctx.ui.notify?.(`Ralph Loop stopped: ${reason}`, "warning");
}

function finishLoop(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
      notify?: (message: string, level: "info" | "warning" | "error") => void;
    };
  },
) {
  if (!activeLoop) return;
  const summary = formatLoopStatus(activeLoop).replace("Ralph Loop running", "Ralph Loop done");
  appendState(pi, "done", { status: summary });
  ctx.ui.setStatus(STATUS_KEY, undefined);
  ctx.ui.notify?.(
    `Ralph Loop done. Completed ${activeLoop.completed.length}, skipped ${activeLoop.skipped.length}.`,
    "info",
  );
  activeLoop = undefined;
}

function sendUserMessage(pi: ExtensionAPI, ctx: { isIdle?: () => boolean }, message: string) {
  if (ctx.isIdle?.()) pi.sendUserMessage(message);
  else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function issueContextMarker(state: LoopState, issue: IssueRef): string {
  return `${ISSUE_CONTEXT_MARKER_PREFIX} ${state.id}:${issue.relPath}:attempt-${state.currentAttempt}`;
}

function containsText(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
  if (typeof value === "string") return value.includes(needle);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle, seen));
  return Object.values(value as Record<string, unknown>).some((item) =>
    containsText(item, needle, seen),
  );
}

function issuePrompt(state: LoopState, issue: IssueRef, retryContext?: string): string {
  return [
    "You are running Ralph Loop, an autonomous local .scratch issue loop.",
    "",
    `Repo root: ${state.repoRoot}`,
    `Current issue file: ${issue.relPath}`,
    issueContextMarker(state, issue),
    `Issue title: ${issue.title}`,
    `Attempt: ${state.currentAttempt}/${state.maxAttempts}`,
    `Selected issue ${state.startedIssues}/${state.maxIssues}; remaining after this: ${state.queue.length}`,
    "",
    retryContext
      ? `The previous commit was rejected (normally by a pre-commit hook). Fix the reported problems before calling ralph_issue_result again. If the hook cannot be fixed in this issue's scope and you ran the relevant checks independently, you can set noVerify=true and explain why in the summary.\n\n${retryContext}`
      : undefined,
    "Rules:",
    "1. The issue file under .scratch/ is the source of truth for this task. Read it first.",
    "2. Follow the repo's own contribution guidelines (AGENTS.md/CONTRIBUTING and its documented harness). Do not invent your own build/test commands.",
    "3. Work autonomously. Do not ask for approval before implementation.",
    "4. Stop instead of guessing if the issue needs product judgment, secrets, external access, destructive actions, or an important unresolved ambiguity.",
    "5. Local signed commits are allowed when needed, but do not amend, tag, push, or rewrite git history unless explicitly instructed. The Ralph Loop extension normally owns the final commit creation.",
    "6. Do not move to another issue yourself. Do not loop manually.",
    "7. When this issue reaches a terminal state, call ralph_issue_result as your final action. Do not provide a normal final answer instead.",
    "",
    "Call ralph_issue_result with:",
    "- outcome=completed only after implementing the issue per the repo guidelines.",
    "- outcome=skipped if the issue is already done, not legitimate, not actionable, or outside the repo's current scope.",
    "- outcome=needs_human if meaningful human judgment/input is required.",
    "- outcome=blocked if an unexpected/unfixable technical failure prevents progress.",
    "",
    "For completed, include a concise conventional-commit commitMessage. The extension will mark the issue Status as done, stage all changes, and create a signed commit using the configured agent git identity. The first commit attempt runs the repo's pre-commit hooks. After a hook rejection, fix the problem and retry, or set noVerify=true only when the hook cannot be fixed in scope and the relevant checks pass independently.",
  ]
    .filter(Boolean)
    .join("\n");
}

function startNextIssue(
  pi: ExtensionAPI,
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
      notify?: (message: string, level: "info" | "warning" | "error") => void;
    };
    isIdle?: () => boolean;
  },
) {
  const state = activeLoop;
  if (!state) return;
  if (state.stoppedReason) return;

  if (state.startedIssues >= state.maxIssues || state.queue.length === 0) {
    finishLoop(pi, ctx);
    return;
  }

  const issue = state.queue.shift()!;
  state.current = issue;
  state.currentAttempt = 1;
  state.startedIssues += 1;
  appendState(pi, "issue-start", { issue: issue.relPath, attempt: state.currentAttempt });
  updateStatus(ctx, state);
  sendUserMessage(pi, ctx, issuePrompt(state, issue));
}

async function handleCompleted(
  pi: ExtensionAPI,
  params: { summary: string; commitMessage?: string; noVerify?: boolean },
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
      notify?: (message: string, level: "info" | "warning" | "error") => void;
    };
    isIdle?: () => boolean;
    signal?: AbortSignal | undefined;
  },
) {
  const state = activeLoop;
  const issue = state?.current;
  if (!state || !issue) throw new Error("No active Ralph Loop issue.");
  if (params.noVerify && state.currentAttempt === 1) {
    throw new Error("noVerify is available only after a verified commit attempt is rejected.");
  }

  appendState(pi, "issue-result", {
    issue: issue.relPath,
    outcome: "completed",
    summary: params.summary,
    noVerify: params.noVerify ?? false,
  });
  updateStatus(ctx, state);
  await ensureNoMergeState(pi, state.repoRoot);

  const statusBeforeCommit = await gitStatus(pi, state.repoRoot);
  if (!statusBeforeCommit) {
    stopLoop(pi, ctx, `Issue ${issue.relPath} was reported completed but produced no git changes.`);
    return "Stopped: completed issue produced no git changes.";
  }

  await markIssueDone(issue);

  const message = safeCommitMessage(params.commitMessage, issue);
  const noVerify = params.noVerify ?? false;
  ctx.ui.notify?.(
    `Ralph Loop committing ${issue.relPath}${noVerify ? " with --no-verify" : ""}`,
    noVerify ? "warning" : "info",
  );
  const commit = await commitCurrentIssue(pi, state, issue, message, noVerify);
  if (!commit.ok) {
    // The commit was rejected, normally by a pre-commit hook guarding quality.
    appendState(pi, "commit-rejected", {
      issue: issue.relPath,
      attempt: state.currentAttempt,
      output: commit.output,
    });
    if (state.currentAttempt >= state.maxAttempts) {
      stopLoop(
        pi,
        ctx,
        `Commit rejected for ${issue.relPath} after ${state.currentAttempt}/${state.maxAttempts} attempts.`,
      );
      return `Commit rejected and max attempts were exhausted.\n\n${commit.output}`;
    }

    state.currentAttempt += 1;
    updateStatus(ctx, state);
    const retryContext = truncateText(commit.output, 6000);
    sendUserMessage(pi, ctx, issuePrompt(state, issue, retryContext));
    return `Commit rejected. Queued retry ${state.currentAttempt}/${state.maxAttempts}.`;
  }

  state.completed.push(issue);
  state.current = undefined;
  appendState(pi, "issue-committed", {
    issue: issue.relPath,
    commitMessage: message,
    noVerify,
    commitOutput: commit.output,
  });
  updateStatus(ctx, state);
  startNextIssue(pi, ctx);
  return [`Completed ${issue.relPath}.`, "", "Commit:", commit.output].join("\n");
}

async function handleSkippedOrBlocked(
  pi: ExtensionAPI,
  outcome: Exclude<RalphOutcome, "completed">,
  params: { summary: string },
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
      notify?: (message: string, level: "info" | "warning" | "error") => void;
    };
    isIdle?: () => boolean;
  },
) {
  const state = activeLoop;
  const issue = state?.current;
  if (!state || !issue) throw new Error("No active Ralph Loop issue.");

  appendState(pi, "issue-result", { issue: issue.relPath, outcome, summary: params.summary });
  const status = await gitStatus(pi, state.repoRoot);
  if (status) {
    stopLoop(
      pi,
      ctx,
      `${outcome} for ${issue.relPath} left a dirty git tree. Human review required.`,
    );
    return `Stopped: outcome=${outcome} left dirty git changes.\n\n${status}`;
  }

  if (outcome === "skipped") {
    state.skipped.push(issue);
    state.current = undefined;
    updateStatus(ctx, state);
    startNextIssue(pi, ctx);
    return `Skipped ${issue.relPath}. Queued next issue if any.`;
  }

  stopLoop(pi, ctx, `${outcome} for ${issue.relPath}: ${params.summary}`);
  return `Stopped: ${outcome} for ${issue.relPath}.`;
}

async function startLoop(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
  if (activeLoop && !activeLoop.stoppedReason) {
    ctx.ui.notify("A Ralph Loop is already running. Use /ralph-loop stop first.", "warning");
    return;
  }

  const options = parseStartOptions(args);
  const root = await repoRoot(pi);
  const scratchDir = join(root, ".scratch");
  if (!(await pathExists(scratchDir)))
    throw new Error(`No .scratch/ directory found at ${scratchDir}`);

  if (!options.allowDirty) {
    const status = await gitStatus(pi, root);
    if (status) {
      throw new Error(
        `Refusing to start Ralph Loop from a dirty git tree. Commit/stash first or pass --allow-dirty.\n\n${status}`,
      );
    }
  }

  let issues = await resolveIssueSelectors(options.selectors, root, scratchDir);
  if (!options.includeDone) issues = issues.filter((issue) => !isTerminalStatus(issue.status));
  if (issues.length === 0) {
    ctx.ui.notify("No non-done .scratch issues matched the selector(s).", "info");
    return;
  }

  const maxIssues = Math.min(options.maxIssues ?? issues.length, issues.length);
  activeLoop = {
    id: `${Date.now()}`,
    cwd: ctx.cwd,
    repoRoot: root,
    scratchDir,
    issues,
    queue: issues.slice(),
    currentAttempt: 0,
    startedIssues: 0,
    completed: [],
    skipped: [],
    maxIssues,
    maxAttempts: options.maxAttempts,
    allowDirty: options.allowDirty,
    includeDone: options.includeDone,
    startedAt: Date.now(),
  };

  appendState(pi, "start", {
    repoRoot: root,
    issues: issues.map((issue) => issue.relPath),
    maxIssues,
    maxAttempts: options.maxAttempts,
  });
  ctx.ui.notify(
    `Ralph Loop starting with ${maxIssues}/${issues.length} selected .scratch issues.`,
    "info",
  );
  updateStatus(ctx, activeLoop);
  startNextIssue(pi, ctx);
}

function statusCommand(ctx: ExtensionCommandContext) {
  if (!activeLoop) {
    ctx.ui.notify("No active Ralph Loop.", "info");
    return;
  }

  const lines = [
    formatLoopStatus(activeLoop),
    "",
    "Selected issues:",
    ...activeLoop.issues.map((issue) => `- ${formatIssueLine(issue)}`),
  ];
  ctx.ui.notify(lines.join("\n"), activeLoop.stoppedReason ? "warning" : "info");
}

function resumeLoop(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  if (!activeLoop) {
    ctx.ui.notify("No Ralph Loop to resume. Use /ralph-loop start.", "info");
    return;
  }
  const state = activeLoop;
  if (!state.stoppedReason) {
    ctx.ui.notify("Ralph Loop is already running.", "warning");
    return;
  }

  state.stoppedReason = undefined;
  appendState(pi, "resumed", { status: formatLoopStatus(state) });

  if (state.current) {
    // Re-attempt the issue that stopped the loop (for example after needs_human).
    // startedIssues already counts this issue, so do not increment it again.
    const issue = state.current;
    state.currentAttempt = 1;
    appendState(pi, "issue-start", {
      issue: issue.relPath,
      attempt: state.currentAttempt,
      resumed: true,
    });
    updateStatus(ctx, state);
    ctx.ui.notify(`Ralph Loop resuming ${issue.relPath}.`, "info");
    sendUserMessage(pi, ctx, issuePrompt(state, issue));
    return;
  }

  ctx.ui.notify("Ralph Loop resuming.", "info");
  updateStatus(ctx, state);
  startNextIssue(pi, ctx);
}

function stopCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  if (!activeLoop) {
    ctx.ui.notify("No active Ralph Loop.", "info");
    return;
  }
  stopLoop(pi, ctx, "Stopped by user.");
  activeLoop = undefined;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}

export default function ralphLoopExtension(pi: ExtensionAPI) {
  pi.registerCommand("ralph-loop", {
    description: "Run an autonomous Ralph Loop over explicitly selected local .scratch issue files",
    getArgumentCompletions: (prefix: string) => {
      const commands = ["start", "status", "resume", "continue", "stop", "reset", "help"];
      const trimmed = prefix.trim();
      if (trimmed.includes(" ")) return null;
      const matches = commands.filter((command) => command.startsWith(trimmed));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const commandMatch = trimmed.match(
        /^(start|status|resume|continue|stop|reset|help)(?:\s+|$)/,
      );
      const command = commandMatch?.[1] ?? (trimmed ? "start" : "help");
      const commandArgs = commandMatch ? trimmed.slice(commandMatch[0].length).trim() : trimmed;

      try {
        switch (command) {
          case "start":
            await startLoop(pi, commandArgs, ctx);
            return;
          case "status":
            statusCommand(ctx);
            return;
          case "resume":
          case "continue":
            resumeLoop(pi, ctx);
            return;
          case "stop":
          case "reset":
            stopCommand(pi, ctx);
            return;
          case "help":
            ctx.ui.notify(helpText(), "info");
            return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, message.startsWith("Usage:") ? "info" : "error");
      }
    },
  });

  pi.registerTool({
    name: "ralph_issue_result",
    label: "Ralph Issue Result",
    description:
      "Report the terminal result for the current Ralph Loop .scratch issue. Use only when a Ralph Loop issue is completed, skipped, needs human input, or is blocked.",
    promptSnippet: "Report the terminal result for the current Ralph Loop issue",
    promptGuidelines: [
      "Use ralph_issue_result as the final action for each Ralph Loop issue; do not move to the next issue yourself.",
      "Use ralph_issue_result outcome=needs_human instead of guessing when a Ralph Loop issue needs meaningful human judgment.",
    ],
    parameters: Type.Object({
      outcome: StringEnum(OUTCOME_VALUES),
      summary: Type.String({
        description: "Concise summary of what happened and why this outcome is correct.",
      }),
      commitMessage: Type.Optional(
        Type.String({
          description:
            "Required for completed: concise conventional-commit message for the signed commit.",
        }),
      ),
      noVerify: Type.Optional(
        Type.Boolean({
          description:
            "For completed retries only: commit with --no-verify when the rejected hook cannot be fixed in scope and relevant checks passed independently.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!activeLoop || !activeLoop.current) {
        return {
          content: [
            {
              type: "text",
              text: "No active Ralph Loop issue. Do not call ralph_issue_result outside /ralph-loop.",
            },
          ],
          details: {},
          terminate: true,
        };
      }

      const toolCtx = { ...ctx, signal };
      let text: string;
      if (params.outcome === "completed") {
        text = await handleCompleted(pi, params, toolCtx);
      } else {
        text = await handleSkippedOrBlocked(pi, params.outcome, params, toolCtx);
      }

      return {
        content: [{ type: "text", text }],
        details: {
          outcome: params.outcome,
          active: activeLoop ? formatLoopStatus(activeLoop) : "done",
        },
        terminate: true,
      };
    },
  });

  pi.on("context", async (event) => {
    const state = activeLoop;
    if (!state?.current) return undefined;

    const markerNeedle = `${ISSUE_CONTEXT_MARKER_PREFIX} ${state.id}:${state.current.relPath}:`;
    let startIndex = -1;
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (containsText(event.messages[i], markerNeedle)) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) return undefined;
    return { messages: event.messages.slice(startIndex) };
  });

  pi.on("session_shutdown", async () => {
    activeLoop = undefined;
  });
}
