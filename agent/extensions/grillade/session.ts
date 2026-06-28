import { randomUUID } from "node:crypto";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { buildKickoffPrompt, buildResumePrompt } from "./prompts.ts";
import {
  GRILLADE_STATE_CUSTOM_TYPE,
  GRILLADE_STATE_VERSION,
  appendGrilladeAnswerSubmitted,
  appendGrilladePaused,
  appendGrilladeResumed,
  initialGrilladeState,
  reconstructGrilladeState,
  type GrilladeStateEntry,
  type SemanticGrilladeState,
} from "./state.ts";
import { askGrilladeQuestionInUi } from "./ui/question.ts";

const DEFAULT_DOCS_MODE = true;
const MAX_SESSION_NAME_PROMPT_LENGTH = 60;
const MAX_SELECTOR_PROMPT_LENGTH = 80;

type GrilladeCommandArgs =
  | { kind: "start"; prompt: string; docsMode: boolean }
  | { kind: "resume" }
  | { kind: "invalid"; message: string };

type GrilladeResumeCandidate = {
  file: string;
  state: SemanticGrilladeState;
  info: SessionInfo;
};

export function registerGrilladeCommand(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    restoreGrilladeUiForSession(ctx);
  });

  pi.registerCommand("grillade", {
    description: "Start or resume a focused Grillade design interview",
    handler: async (args, ctx) => {
      await handleGrilladeCommand(args, ctx, pi);
    },
  });
}

export async function handleGrilladeCommand(
  args: string,
  ctx: ExtensionCommandContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (!ensureTuiMode(ctx)) return;

  const parsed = parseGrilladeArgs(args);
  if (parsed.kind === "invalid") {
    notify(ctx, parsed.message, "warning");
    return;
  }

  if (parsed.kind === "resume") {
    await resumeGrillade(ctx, pi);
    return;
  }

  await startNewGrillade(parsed, ctx);
}

export function parseGrilladeArgs(args: string): GrilladeCommandArgs {
  let rest = args.trim();
  if (rest.length === 0) return { kind: "resume" };

  let docsMode = DEFAULT_DOCS_MODE;
  if (rest === "--no-docs") {
    return { kind: "invalid", message: "Usage: /grillade --no-docs <prompt>" };
  }
  if (/^--no-docs\s/.test(rest)) {
    docsMode = false;
    rest = rest.slice("--no-docs".length).trimStart();
  }

  if (/^--\s/.test(rest)) {
    rest = rest.slice(2).trimStart();
  } else if (rest.startsWith("--")) {
    const flag = rest.split(/\s+/, 1)[0] ?? rest;
    return { kind: "invalid", message: `Unknown /grillade option: ${flag}` };
  }

  if (rest.length === 0) {
    return { kind: "invalid", message: "Usage: /grillade <prompt>" };
  }

  return { kind: "start", prompt: rest, docsMode };
}

async function startNewGrillade(
  args: Extract<GrilladeCommandArgs, { kind: "start" }>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();

  const grilladeId = randomUUID();
  const startedAt = new Date().toISOString();
  const prompt = args.prompt;
  const docsMode = args.docsMode;
  const cwd = ctx.cwd;
  const parentSession = ctx.sessionManager.getSessionFile();
  const sessionName = formatSessionName(prompt);
  const kickoff = buildKickoffPrompt({ prompt, docsMode });

  const newSessionOptions: Parameters<ExtensionCommandContext["newSession"]>[0] = {
    setup: async (sessionManager) => {
      const state = initialGrilladeState({
        grilladeId,
        prompt,
        docsMode,
        at: startedAt,
        cwd,
        sessionId: sessionManager.getSessionId(),
      });
      const entry: GrilladeStateEntry = {
        entryVersion: GRILLADE_STATE_VERSION,
        kind: "snapshot",
        state,
        recordedAt: startedAt,
      };
      sessionManager.appendSessionInfo(sessionName);
      sessionManager.appendCustomEntry(GRILLADE_STATE_CUSTOM_TYPE, entry);
    },
    withSession: async (replacementCtx) => {
      await openStartedGrillade(replacementCtx, kickoff, sessionName, docsMode);
    },
  };
  if (parentSession !== undefined) newSessionOptions.parentSession = parentSession;

  const result = await ctx.newSession(newSessionOptions);

  if (result.cancelled) {
    notify(ctx, "Grillade start was cancelled by a session switch hook.", "warning");
  }
}

async function openStartedGrillade(
  ctx: Pick<ExtensionCommandContext, "ui"> & { sendUserMessage(content: string): Promise<void> },
  kickoff: string,
  sessionName: string,
  docsMode: boolean,
): Promise<void> {
  ctx.ui.setTitle(sessionName);
  ctx.ui.setStatus("grillade", docsMode ? "Grillade • docs" : "Grillade • no docs");
  notify(ctx, `Started ${sessionName}.`, "info");
  await ctx.sendUserMessage(kickoff);
}

async function resumeGrillade(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const currentState = reconstructGrilladeState(ctx.sessionManager);
  if (isIncompleteGrillade(currentState)) {
    await reopenCurrentGrillade(ctx, currentState, pi);
    return;
  }

  await ctx.waitForIdle();
  const candidates = await findIncompleteGrilladeSessions(ctx.cwd);
  if (candidates.length === 0) {
    notify(
      ctx,
      "No incomplete Grillade session found for this directory. Start one with /grillade <prompt>.",
      "info",
    );
    return;
  }

  const candidate =
    candidates.length === 1 ? candidates[0] : await selectResumeCandidate(ctx, candidates);
  if (!candidate) {
    notify(ctx, "Grillade resume cancelled.", "info");
    return;
  }

  const sessionName = candidate.info.name ?? formatSessionName(candidate.state.metadata.prompt);
  const statusText = formatStatusText(candidate.state);
  const result = await ctx.switchSession(candidate.file, {
    withSession: async (replacementCtx) => {
      replacementCtx.ui.setTitle(sessionName);
      replacementCtx.ui.setStatus("grillade", statusText);
      notify(replacementCtx, `Resumed ${sessionName}.`, "info");
      await continueResumedGrillade(replacementCtx, candidate.state, pi, replacementCtx);
    },
  });

  if (result.cancelled) {
    notify(ctx, "Grillade resume was cancelled by a session switch hook.", "warning");
  }
}

async function reopenCurrentGrillade(
  ctx: ExtensionCommandContext,
  state: SemanticGrilladeState,
  pi: ExtensionAPI,
): Promise<void> {
  const sessionName =
    ctx.sessionManager.getSessionName() ?? formatSessionName(state.metadata.prompt);
  ctx.ui.setTitle(sessionName);
  ctx.ui.setStatus("grillade", formatStatusText(state));
  notify(ctx, `Reopened ${sessionName}.`, "info");
  await continueResumedGrillade(ctx, state, pi, pi);
}

type GrilladeMessageSender = {
  sendUserMessage(content: string): void | Promise<void>;
};

async function continueResumedGrillade(
  ctx: ExtensionCommandContext,
  state: SemanticGrilladeState,
  pi: ExtensionAPI,
  sender: GrilladeMessageSender,
): Promise<void> {
  appendGrilladeResumed(pi);
  if (!state.activeQuestion) {
    await sender.sendUserMessage(buildResumePrompt(state));
    return;
  }

  const result = await askGrilladeQuestionInUi(ctx, state.activeQuestion, undefined, {
    docsMode: state.metadata.docsMode,
  });
  if (result.status === "answered") {
    appendGrilladeAnswerSubmitted(pi, result);
    await sender.sendUserMessage(buildResumePrompt(state, result));
    return;
  }

  if (result.status === "paused") appendGrilladePaused(pi, result.at, result);
  notify(
    ctx,
    "Grillade question closed without submitting an answer. Run /grillade to reopen it.",
    "info",
  );
}

function restoreGrilladeUiForSession(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  const state = reconstructGrilladeState(ctx.sessionManager);
  if (!isIncompleteGrillade(state)) {
    ctx.ui.setStatus("grillade", undefined);
    return;
  }
  const sessionName =
    ctx.sessionManager.getSessionName() ?? formatSessionName(state.metadata.prompt);
  ctx.ui.setTitle(sessionName);
  ctx.ui.setStatus("grillade", formatStatusText(state));
}

async function findIncompleteGrilladeSessions(cwd: string): Promise<GrilladeResumeCandidate[]> {
  const sessions = await SessionManager.list(cwd);
  const candidates: GrilladeResumeCandidate[] = [];
  for (const info of sessions) {
    const candidate = loadResumeCandidate(info, cwd);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((a, b) => b.info.modified.getTime() - a.info.modified.getTime());
}

function loadResumeCandidate(info: SessionInfo, cwd: string): GrilladeResumeCandidate | undefined {
  try {
    const sessionManager = SessionManager.open(info.path);
    const state = reconstructGrilladeState(sessionManager);
    if (!isIncompleteGrillade(state)) return undefined;
    if (!isSessionForCwd(state, info, sessionManager.getCwd(), cwd)) return undefined;
    return { file: info.path, state, info };
  } catch {
    return undefined;
  }
}

async function selectResumeCandidate(
  ctx: ExtensionCommandContext,
  candidates: readonly GrilladeResumeCandidate[],
): Promise<GrilladeResumeCandidate | undefined> {
  const options = candidates.map(formatCandidateOption);
  const choice = await ctx.ui.select("Resume Grillade session", options);
  if (!choice) return undefined;
  const index = options.indexOf(choice);
  return index >= 0 ? candidates[index] : undefined;
}

function ensureTuiMode(ctx: ExtensionCommandContext): boolean {
  if (ctx.mode === "tui") return true;
  const message =
    "/grillade is available in Pi TUI mode only. Start Pi interactively, then run /grillade <prompt>.";
  if (ctx.hasUI) {
    notify(ctx, message, "warning");
    return false;
  }
  throw new Error(message);
}

function isIncompleteGrillade(
  state: SemanticGrilladeState | undefined,
): state is SemanticGrilladeState {
  return state !== undefined && state.status !== "finished";
}

function isSessionForCwd(
  state: SemanticGrilladeState,
  info: SessionInfo,
  sessionCwd: string,
  cwd: string,
): boolean {
  const semanticCwd = state.metadata.cwd;
  if (semanticCwd !== undefined) return semanticCwd === cwd;
  return info.cwd === cwd || sessionCwd === cwd;
}

function formatSessionName(prompt: string): string {
  return `Grillade: ${truncateOneLine(prompt, MAX_SESSION_NAME_PROMPT_LENGTH)}`;
}

function formatCandidateOption(candidate: GrilladeResumeCandidate): string {
  const name = candidate.info.name ?? formatSessionName(candidate.state.metadata.prompt);
  const modified = candidate.info.modified.toLocaleString();
  const prompt = truncateOneLine(candidate.state.metadata.prompt, MAX_SELECTOR_PROMPT_LENGTH);
  return `${name} — ${candidate.state.status}, ${modified} — ${prompt}`;
}

function formatStatusText(state: SemanticGrilladeState): string {
  const suffix = state.metadata.docsMode ? " • docs" : " • no docs";
  return `Grillade ${state.currentPhase}${suffix}`;
}

function truncateOneLine(text: string, maxLength: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function notify(
  ctx: Pick<ExtensionCommandContext, "ui">,
  message: string,
  type: "info" | "warning" | "error",
): void {
  ctx.ui.notify(message, type);
}
