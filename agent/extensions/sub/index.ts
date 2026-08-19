import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type AutocompleteItem, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { launchKittyChildPi } from "./launcher.ts";
import {
  type ContextPacket,
  type DelegationJobRecord,
  type DelegationJobStatusRecord,
  SUB_CUSTOM_JOB,
  SUB_CUSTOM_RESULT,
  atomicWriteFile,
  buildJobId,
  childPromptPath,
  completeDelegationJob,
  contextPath,
  ensureSubRootIgnored,
  getJobDir,
  requestPath,
  transitionJobStatus,
  writeJobStatus,
  writeJsonFile,
} from "./mailbox.ts";
import { ChildDelegationLifecycle, type ChildLifecycleWarning } from "./lifecycle.ts";
import { createParentMailboxCoordinator, type ParentMailboxCoordinator } from "./parent-mailbox.ts";
import {
  buildChildCompletionMessage,
  buildChildSystemPrompt,
  buildInitialChildPrompt,
  buildParentLaunchMessage,
} from "./prompts.ts";

const RESULT_CONTEXT_CAP_BYTES = 200 * 1024;
const CHILD_WARNING_STATUS_KEY = "sub-delegation-result-warning";

interface LaunchDelegationJobOptions {
  prompt: string;
  displayPrompt: string;
  initialPrompt: string;
  handoffMode: "fresh" | "fork";
  skillName?: string;
  forkSessionFile?: string;
}

export class SubAgentFinishedComponent implements Component {
  private readonly theme: {
    bg(color: string, text: string): string;
    fg(color: string, text: string): string;
    bold(text: string): string;
  };
  private readonly detail: string | undefined;

  constructor(
    theme: {
      bg(color: string, text: string): string;
      fg(color: string, text: string): string;
      bold(text: string): string;
    },
    detail?: string,
  ) {
    this.theme = theme;
    this.detail = detail;
  }

  render(width: number): string[] {
    const bar = centerText(" sub-agent finished ", Math.max(1, width));
    const lines = [this.theme.bg("toolSuccessBg", this.theme.fg("success", this.theme.bold(bar)))];
    const detail = this.detail?.trim();
    if (detail) lines.push(truncateToWidth(this.theme.fg("dim", firstLine(detail)), width));
    return lines;
  }

  invalidate(): void {}
}

const SubDoneParams = Type.Object({
  result: Type.String({
    description: "Compact Markdown Delegation Result to send back to the parent Pi session",
  }),
});

export default function subExtension(pi: ExtensionAPI): void {
  let parentMailbox: ParentMailboxCoordinator | undefined;
  let childLifecycle: ChildDelegationLifecycle | undefined;

  pi.registerMessageRenderer(
    SUB_CUSTOM_RESULT,
    (message, _options, theme) =>
      new SubAgentFinishedComponent(theme, getTextContent(message.content)),
  );

  pi.registerCommand("sub", {
    description:
      "Open an interactive kitty Pi sub-agent; use --skill for skills and --with-fresh-context for minimal context",
    getArgumentCompletions: (prefix) => getSubCompletions(pi, prefix),
    handler: async (args, ctx) => {
      if (getChildJobFromEnv()) {
        ctx.ui.notify("Recursive sub-agents are disabled inside /sub child sessions", "error");
        return;
      }

      const parsed = parseSubArgs(args);
      if (!parsed) {
        ctx.ui.notify(
          "Usage: /sub [--skill <skill-name>] [--with-fresh-context] [prompt]",
          "error",
        );
        return;
      }

      let prompt = parsed.prompt;
      if (!parsed.skillName && !prompt) {
        const edited = await getDelegationPrompt("", ctx);
        if (!edited) return;
        prompt = edited;
      }

      const canForkParent = hasForkableConversation(ctx.sessionManager.getBranch());
      const forkSessionFile =
        !parsed.fresh && canForkParent ? ctx.sessionManager.getSessionFile() : undefined;
      const handoffMode = forkSessionFile ? "fork" : "fresh";

      const childPrompt = parsed.skillName
        ? prompt
          ? `/skill:${parsed.skillName} ${prompt}`
          : `/skill:${parsed.skillName}`
        : prompt;

      if (!parentMailbox) throw new Error("Parent Job Mailbox is not ready");
      await launchDelegationJob(pi, parentMailbox, ctx, {
        prompt: childPrompt,
        displayPrompt: prompt,
        initialPrompt: parsed.skillName
          ? childPrompt
          : buildInitialChildPrompt("{jobId}", childPrompt, "{jobDir}"),
        handoffMode,
        ...(parsed.skillName ? { skillName: parsed.skillName } : {}),
        ...(forkSessionFile ? { forkSessionFile } : {}),
      });
    },
  });

  pi.registerCommand("sub-done", {
    description: "Complete the current sub-agent job with a compact Markdown result",
    handler: async (args, ctx) => {
      const job = getChildJobFromEnv();
      if (!job) {
        ctx.ui.notify("/sub-done is only available inside a /sub child Pi session", "error");
        return;
      }

      const result = await getDelegationResult(args, ctx);
      if (!result) return;

      await completeChildJob(job.jobId, job.jobDir, result);
      childLifecycle?.completed();
      clearChildWarning(ctx);
      pi.sendMessage({
        customType: SUB_CUSTOM_RESULT,
        content: buildChildCompletionMessage(job.jobId, result),
        display: true,
        details: { jobId: job.jobId, jobDir: job.jobDir },
      });
      ctx.ui.notify(`Wrote Delegation Result for ${job.jobId}`, "info");
    },
  });

  pi.registerTool({
    name: "sub_done",
    label: "Sub-agent Done",
    description:
      "Complete the current /sub child job by writing a compact Delegation Result to the parent mailbox.",
    promptSnippet:
      "Complete the current /sub child job with a compact result for the parent session",
    promptGuidelines: [
      "Use sub_done only inside a /sub child session, when the delegated task has reached a terminal outcome for the parent session.",
      "Do not use sub_done for intermediate human-in-the-loop states; ask for confirmation or clarification inside the child session and wait there instead.",
      "The sub_done result should summarize conclusions and handoff data, not raw command logs or the full child transcript.",
      "Calling sub_done is your final action; do not write a separate final answer, recap, or summary afterward.",
    ],
    parameters: SubDoneParams,
    renderResult(result, _options, theme) {
      return new SubAgentFinishedComponent(theme, getTextContent(result.content));
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const job = getChildJobFromEnv();
      if (!job) throw new Error("sub_done is only available inside a /sub child Pi session");

      await completeChildJob(job.jobId, job.jobDir, params.result);
      childLifecycle?.completed();
      clearChildWarning(ctx);
      return {
        content: [{ type: "text", text: buildChildCompletionMessage(job.jobId, params.result) }],
        details: { jobId: job.jobId, jobDir: job.jobDir, result: params.result },
        terminate: true,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    configureSubDoneTool(pi);
    const childJob = getChildJobFromEnv();
    if (childJob) {
      childLifecycle = new ChildDelegationLifecycle(childJob, childWarning(ctx));
      await childLifecycle.restore();
      return;
    }
    parentMailbox = createParentMailboxCoordinator(
      pi,
      {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() ?? null,
      },
      {
        diagnostic: (message) => {
          if (ctx.hasUI) ctx.ui.notify(message, "warning");
          else console.error(message);
        },
        truncateResult: truncateResultForContext,
      },
    );
    await parentMailbox.restore(ctx.sessionManager.getBranch());
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!childLifecycle) return;
    await childLifecycle.agentStart();
    clearChildWarning(ctx);
  });

  // agent_settled exists at runtime in Pi 0.80, but its published ExtensionAPI type omits it.
  const lifecycle = pi as ExtensionAPI & {
    on(event: "agent_settled", handler: () => Promise<void>): void;
  };
  lifecycle.on("agent_settled", async () => {
    if (childLifecycle) await childLifecycle.agentSettled();
  });

  pi.on("context", (event) => ({
    messages: removeAnsweredDelegationResults(event.messages),
  }));

  pi.on("session_shutdown", (_event, ctx) => {
    parentMailbox?.stop();
    parentMailbox = undefined;
    childLifecycle = undefined;
    clearChildWarning(ctx);
  });
}

async function getDelegationPrompt(
  args: string,
  ctx: {
    hasUI: boolean;
    ui: {
      editor: (title: string, initial?: string) => Promise<string | undefined>;
      notify: (message: string, level: "info" | "warning" | "error") => void;
    };
  },
): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;
  if (!ctx.hasUI) return undefined;

  const edited = await ctx.ui.editor("Sub-agent prompt", "");
  const prompt = edited?.trim();
  if (!prompt) {
    ctx.ui.notify("Canceled: empty sub-agent prompt", "warning");
    return undefined;
  }
  return prompt;
}

async function getDelegationResult(
  args: string,
  ctx: {
    hasUI: boolean;
    ui: {
      editor: (title: string, initial?: string) => Promise<string | undefined>;
      notify: (message: string, level: "info" | "warning" | "error") => void;
    };
  },
): Promise<string | undefined> {
  const trimmed = args.trim();
  if (trimmed) return trimmed;
  if (!ctx.hasUI) return undefined;

  const edited = await ctx.ui.editor("Delegation Result", "");
  const result = edited?.trim();
  if (!result) {
    ctx.ui.notify("Canceled: empty Delegation Result", "warning");
    return undefined;
  }
  return result;
}

async function launchDelegationJob(
  pi: ExtensionAPI,
  parentMailbox: ParentMailboxCoordinator,
  ctx: any,
  options: LaunchDelegationJobOptions,
): Promise<void> {
  const jobId = buildJobId();
  const jobDir = getJobDir(jobId);
  const createdAt = new Date().toISOString();
  const contextPacket = buildContextPacket(jobId, createdAt, ctx, pi, options);
  const childSystemPrompt = buildChildSystemPrompt(jobId, jobDir);
  const initialPrompt = options.initialPrompt
    .replaceAll("{jobId}", jobId)
    .replaceAll("{jobDir}", jobDir);

  await ensureSubRootIgnored();
  await atomicWriteFile(requestPath(jobDir), `${options.prompt.trim()}\n`);
  await writeJsonFile(contextPath(jobDir), contextPacket);
  await atomicWriteFile(childPromptPath(jobDir), childSystemPrompt);
  const initialStatus: DelegationJobStatusRecord = {
    status: "created",
    jobId,
    createdAt,
    updatedAt: createdAt,
    parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
    handoffMode: options.handoffMode,
    ...(options.skillName ? { skillName: options.skillName } : {}),
    ...(options.forkSessionFile ? { forkSessionFile: options.forkSessionFile } : {}),
  };
  await writeJobStatus(jobDir, initialStatus);

  const record: DelegationJobRecord = {
    jobId,
    jobDir,
    prompt: options.prompt,
    cwd: ctx.cwd,
    createdAt,
    parentSessionId: ctx.sessionManager.getSessionId(),
    parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
  };
  pi.appendEntry(SUB_CUSTOM_JOB, record);
  await parentMailbox.watch(record);

  try {
    await launchKittyChildPi({
      cwd: ctx.cwd,
      jobId,
      jobDir,
      childSystemPromptPath: childPromptPath(jobDir),
      initialPrompt,
      ...(options.forkSessionFile ? { forkSessionFile: options.forkSessionFile } : {}),
    });
    await transitionJobStatus(
      jobDir,
      "launched",
      new Date(),
      options.forkSessionFile ? { forkSessionFile: options.forkSessionFile } : {},
    );
    pi.sendMessage({
      customType: SUB_CUSTOM_JOB,
      content: buildParentLaunchMessage(jobId, {
        prompt: options.displayPrompt,
        handoffMode: options.handoffMode,
        ...(options.skillName ? { skillName: options.skillName } : {}),
      }),
      display: true,
      details: { jobId, jobDir, handoffMode: options.handoffMode, skillName: options.skillName },
    });
    ctx.ui.notify(`Launched sub-agent ${jobId}`, "info");
  } catch (error) {
    parentMailbox.stopJob(jobId);
    await transitionJobStatus(jobDir, "launch-failed", new Date(), {
      error: error instanceof Error ? error.message : String(error),
    });
    ctx.ui.notify(`Failed to launch kitty for sub-agent ${jobId}: ${formatError(error)}`, "error");
  }
}

interface ParsedSubArgs {
  fresh: boolean;
  skillName?: string;
  prompt: string;
}

function parseSubArgs(args: string): ParsedSubArgs | undefined {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let rest = args.trim();
  let fresh = false;
  let skillName: string | undefined;

  while (tokens.length > 0) {
    const token = tokens[0];
    if (token === "--with-fresh-context") {
      fresh = true;
      rest = removeLeadingToken(rest, token);
      tokens.shift();
      continue;
    }
    if (token === "--skill") {
      rest = removeLeadingToken(rest, token);
      tokens.shift();
      const skillToken = tokens.shift();
      if (!skillToken) return undefined;
      skillName = normalizeSkillName(skillToken);
      rest = removeLeadingToken(rest, skillToken);
      continue;
    }
    break;
  }

  return { fresh, ...(skillName ? { skillName } : {}), prompt: rest.trim() };
}

function removeLeadingToken(input: string, token: string): string {
  return input.trimStart().slice(token.length).trimStart();
}

function centerText(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  const right = width - text.length - left;
  return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function getSubCompletions(pi: ExtensionAPI, prefix: string): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const lastToken = tokens.at(-1) ?? "";
  const skillFlagIndex = trimmed.lastIndexOf("--skill");

  if (skillFlagIndex >= 0) {
    const afterSkill = trimmed.slice(skillFlagIndex + "--skill".length).trimStart();
    if (!afterSkill.includes(" ")) {
      const valuePrefix = `${trimmed.slice(0, skillFlagIndex + "--skill".length)} `;
      return getSkillCompletions(pi, afterSkill, valuePrefix);
    }
    return null;
  }

  if (tokens.length > 0 && !lastToken.startsWith("--")) return null;

  const completions: AutocompleteItem[] = [];
  if (!tokens.includes("--skill") && "--skill".startsWith(lastToken)) {
    completions.push({
      value: "--skill",
      label: "--skill",
      description: "Run a Pi skill inside the sub-agent",
    });
  }
  if (!tokens.includes("--with-fresh-context") && "--with-fresh-context".startsWith(lastToken)) {
    completions.push({
      value: "--with-fresh-context",
      label: "--with-fresh-context",
      description: "Start with minimal sub-agent context instead of forking this conversation",
    });
  }

  return completions.length > 0 ? completions : null;
}

function getSkillCompletions(
  pi: ExtensionAPI,
  skillPrefix: string,
  valuePrefix?: string,
): AutocompleteItem[] | null {
  const skills = pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({ ...command, skillName: normalizeSkillName(command.name) }))
    .filter((command) => command.skillName.startsWith(skillPrefix));

  const completions: AutocompleteItem[] = skills.map((command) => {
    const item: AutocompleteItem = {
      value: `${valuePrefix ?? ""}${command.skillName}`,
      label: command.skillName,
    };
    if (command.description) item.description = command.description;
    return item;
  });

  return completions.length > 0 ? completions : null;
}

function normalizeSkillName(name: string): string {
  return name.replace(/^\/?skill:/, "");
}

function hasForkableConversation(entries: unknown[]): boolean {
  return entries.some((entry) => {
    if (!isObject(entry)) return false;
    if (entry["type"] !== "message") return false;
    const message = entry["message"];
    return isObject(message) && message["role"] !== "custom";
  });
}

function buildContextPacket(
  jobId: string,
  createdAt: string,
  ctx: any,
  pi: ExtensionAPI,
  options: Pick<LaunchDelegationJobOptions, "handoffMode" | "skillName">,
): ContextPacket {
  const promptOptions = ctx.getSystemPromptOptions?.();
  const contextFiles = Array.isArray(promptOptions?.contextFiles) ? promptOptions.contextFiles : [];
  const contextFilePaths = contextFiles
    .map((file: unknown) =>
      isObject(file) && typeof file["path"] === "string" ? file["path"] : undefined,
    )
    .filter((filePath: string | undefined): filePath is string => filePath !== undefined);

  const packet: ContextPacket = {
    jobId,
    createdAt,
    cwd: ctx.cwd,
    handoffMode: options.handoffMode,
    activeTools: pi.getActiveTools(),
    contextFilePaths,
  };
  if (options.skillName) packet.skillName = options.skillName;

  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (typeof sessionFile === "string") packet.sessionFile = sessionFile;
  const sessionName = ctx.sessionManager?.getSessionName?.();
  if (typeof sessionName === "string") packet.sessionName = sessionName;
  const leafId = ctx.sessionManager?.getLeafId?.();
  if (typeof leafId === "string" || leafId === null) packet.leafId = leafId;
  const usage = ctx.getContextUsage?.();
  if (usage !== undefined) packet.contextUsage = usage;
  const model = ctx.model;
  if (isObject(model) && typeof model["provider"] === "string" && typeof model["id"] === "string") {
    packet.model = `${model["provider"]}/${model["id"]}`;
  }

  return packet;
}

function configureSubDoneTool(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  const isChild = getChildJobFromEnv() !== undefined;
  if (isChild) {
    pi.setActiveTools([...new Set([...active, "sub_done"])]);
  } else if (active.includes("sub_done")) {
    pi.setActiveTools(active.filter((tool) => tool !== "sub_done"));
  }
}

async function completeChildJob(jobId: string, jobDir: string, result: string): Promise<void> {
  await completeDelegationJob(jobId, jobDir, result);
}

function childWarning(ctx: {
  hasUI: boolean;
  ui: {
    theme: { fg(color: "warning", text: string): string };
    setStatus(key: string, value: string | undefined): void;
  };
}): ChildLifecycleWarning {
  return {
    show(message) {
      if (!ctx.hasUI) return;
      ctx.ui.setStatus(
        CHILD_WARNING_STATUS_KEY,
        message ? ctx.ui.theme.fg("warning", message) : undefined,
      );
    },
  };
}

function clearChildWarning(ctx: {
  hasUI: boolean;
  ui: { setStatus(key: string, value: string | undefined): void };
}): void {
  if (ctx.hasUI) ctx.ui.setStatus(CHILD_WARNING_STATUS_KEY, undefined);
}

export function isSubChildSessionEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env["PI_SUB_JOB_ID"] && env["PI_SUB_JOB_DIR"]);
}

function getChildJobFromEnv(): { jobId: string; jobDir: string } | undefined {
  const env = process.env;
  if (!isSubChildSessionEnv(env)) return undefined;
  return { jobId: env["PI_SUB_JOB_ID"]!, jobDir: env["PI_SUB_JOB_DIR"]! };
}

export function removeAnsweredDelegationResults<
  T extends { role?: string; customType?: string; content?: unknown },
>(messages: T[]): T[] {
  return messages.filter((message, index) => {
    if (!isDelegationResultFollowUp(message)) return true;
    return !messages.slice(index + 1).some((later) => later.role === "assistant");
  });
}

function isDelegationResultFollowUp(message: {
  role?: string;
  customType?: string;
  content?: unknown;
}): boolean {
  if (message.role === "custom" && message.customType !== SUB_CUSTOM_RESULT) return false;
  if (message.role !== "user" && message.role !== "custom") return false;
  const text = getTextContent(message.content);
  return (
    text.startsWith("Sub-agent Delegation Job ") && text.includes("\n\nDelegation Result:\n\n")
  );
}

function getTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isObject(part) && part["type"] === "text" && typeof part["text"] === "string"
        ? part["text"]
        : "",
    )
    .join("\n");
}

export function truncateResultForContext(result: string, fullResultPath: string): string {
  const totalBytes = Buffer.byteLength(result, "utf8");
  if (totalBytes <= RESULT_CONTEXT_CAP_BYTES) return result;

  let marker = "";
  let head = "";
  let tail = "";

  for (let attempt = 0; attempt < 3; attempt++) {
    const markerBytes = Buffer.byteLength(marker, "utf8");
    const payloadBudget = Math.max(0, RESULT_CONTEXT_CAP_BYTES - markerBytes);
    const headBudget = Math.ceil(payloadBudget / 2);
    const tailBudget = Math.floor(payloadBudget / 2);

    head = utf8PrefixByBytes(result, headBudget);
    tail = utf8SuffixByBytes(result, tailBudget);
    const omittedBytes = Math.max(
      0,
      totalBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
    );
    const nextMarker = `\n\n[Delegation Result truncated for parent context: original ${formatBytes(totalBytes)}, cap ${formatBytes(RESULT_CONTEXT_CAP_BYTES)}, omitted ${formatBytes(omittedBytes)}. Full result: ${fullResultPath}]\n\n`;
    if (nextMarker === marker) break;
    marker = nextMarker;
  }

  return `${head}${marker}${tail}`;
}

function utf8PrefixByBytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const char of input) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    output += char;
    bytes += charBytes;
  }
  return output;
}

function utf8SuffixByBytes(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  const chars: string[] = [];
  for (const char of Array.from(input).reverse()) {
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    chars.push(char);
    bytes += charBytes;
  }
  return chars.reverse().join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${Math.round(kib)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
