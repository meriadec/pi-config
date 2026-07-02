import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { launchKittyChildPi } from "./launcher.ts";
import {
  type ContextPacket,
  type DelegationJobRecord,
  type DelegationResultRecord,
  SUB_CUSTOM_JOB,
  SUB_CUSTOM_RESULT,
  atomicWriteFile,
  buildJobId,
  childPromptPath,
  contextPath,
  ensureSubRootIgnored,
  getJobDir,
  pathExists,
  readTextFile,
  requestPath,
  resultPath,
  statusPath,
  writeJsonFile,
} from "./mailbox.ts";
import {
  buildChildCompletionMessage,
  buildChildSystemPrompt,
  buildInitialChildPrompt,
  buildParentFollowUp,
  buildParentLaunchMessage,
} from "./prompts.ts";

const WATCH_INTERVAL_MS = 2_000;
const RESULT_CONTEXT_CAP_BYTES = 200 * 1024;

interface RuntimeState {
  watchers: Map<string, ReturnType<typeof setInterval>>;
  importedJobs: Set<string>;
}

interface LaunchDelegationJobOptions {
  prompt: string;
  displayPrompt: string;
  initialPrompt: string;
  handoffMode: "fresh" | "fork";
  skillName?: string;
  forkSessionFile?: string;
}

class SubAgentFinishedComponent implements Component {
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
    if (detail) lines.push(this.theme.fg("dim", firstLine(detail)));
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
  const state: RuntimeState = { watchers: new Map(), importedJobs: new Set() };

  pi.registerMessageRenderer(
    SUB_CUSTOM_RESULT,
    (message, _options, theme) =>
      new SubAgentFinishedComponent(theme, getTextContent(message.content)),
  );

  pi.registerCommand("sub", {
    description:
      "Open an interactive kitty Pi sub-agent; use --skill for skills and --fresh for minimal context",
    getArgumentCompletions: (prefix) => getSubCompletions(pi, prefix),
    handler: async (args, ctx) => {
      if (getChildJobFromEnv()) {
        ctx.ui.notify("Recursive sub-agents are disabled inside /sub child sessions", "error");
        return;
      }

      const parsed = parseSubArgs(args);
      if (!parsed) {
        ctx.ui.notify("Usage: /sub [--fresh] [--skill <skill-name>] [prompt]", "error");
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

      await launchDelegationJob(pi, state, ctx, {
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
    async execute(_toolCallId, params) {
      const job = getChildJobFromEnv();
      if (!job) throw new Error("sub_done is only available inside a /sub child Pi session");

      await completeChildJob(job.jobId, job.jobDir, params.result);
      return {
        content: [{ type: "text", text: buildChildCompletionMessage(job.jobId, params.result) }],
        details: { jobId: job.jobId, jobDir: job.jobDir, result: params.result },
        terminate: true,
      };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    configureSubDoneTool(pi);
    reconstructRuntimeState(pi, state, ctx.sessionManager.getBranch());
  });

  pi.on("context", (event) => ({
    messages: removeAnsweredDelegationResults(event.messages),
  }));

  pi.on("session_shutdown", () => {
    for (const timer of state.watchers.values()) clearInterval(timer);
    state.watchers.clear();
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
  state: RuntimeState,
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
  await writeJsonFile(statusPath(jobDir), {
    status: "created",
    jobId,
    createdAt,
    parentSessionFile: ctx.sessionManager.getSessionFile(),
    handoffMode: options.handoffMode,
    skillName: options.skillName,
  });

  const record: DelegationJobRecord = {
    jobId,
    jobDir,
    prompt: options.prompt,
    cwd: ctx.cwd,
    createdAt,
  };
  pi.appendEntry(SUB_CUSTOM_JOB, record);
  watchJobResult(pi, state, record);

  try {
    await launchKittyChildPi({
      cwd: ctx.cwd,
      jobId,
      jobDir,
      childSystemPromptPath: childPromptPath(jobDir),
      initialPrompt,
      ...(options.forkSessionFile ? { forkSessionFile: options.forkSessionFile } : {}),
    });
    await writeJsonFile(statusPath(jobDir), {
      status: "launched",
      jobId,
      launchedAt: new Date().toISOString(),
      parentSessionFile: ctx.sessionManager.getSessionFile(),
      handoffMode: options.handoffMode,
      skillName: options.skillName,
      forkSessionFile: options.forkSessionFile,
    });
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
    stopWatching(state, jobId);
    await writeJsonFile(statusPath(jobDir), {
      status: "launch_failed",
      jobId,
      failedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      handoffMode: options.handoffMode,
      skillName: options.skillName,
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
    if (token === "--fresh") {
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
  if (!tokens.includes("--fresh") && "--fresh".startsWith(lastToken)) {
    completions.push({
      value: "--fresh",
      label: "--fresh",
      description: "Start with minimal sub-agent context instead of forking this conversation",
    });
  }
  if (!tokens.includes("--skill") && "--skill".startsWith(lastToken)) {
    completions.push({
      value: "--skill",
      label: "--skill",
      description: "Run a Pi skill inside the sub-agent",
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

function reconstructRuntimeState(pi: ExtensionAPI, state: RuntimeState, entries: unknown[]): void {
  state.importedJobs.clear();
  const jobs = new Map<string, DelegationJobRecord>();

  for (const entry of entries) {
    if (!isObject(entry) || entry["type"] !== "custom") continue;
    if (entry["customType"] === SUB_CUSTOM_RESULT && isDelegationResultRecord(entry["data"])) {
      state.importedJobs.add(entry["data"].jobId);
    }
    if (entry["customType"] === SUB_CUSTOM_JOB && isDelegationJobRecord(entry["data"])) {
      jobs.set(entry["data"].jobId, entry["data"]);
    }
  }

  for (const job of jobs.values()) {
    if (!state.importedJobs.has(job.jobId)) watchJobResult(pi, state, job);
  }
}

function watchJobResult(pi: ExtensionAPI, state: RuntimeState, job: DelegationJobRecord): void {
  if (state.watchers.has(job.jobId) || state.importedJobs.has(job.jobId)) return;

  const check = async () => {
    if (state.importedJobs.has(job.jobId)) {
      stopWatching(state, job.jobId);
      return;
    }

    const filePath = resultPath(job.jobDir);
    if (!(await pathExists(filePath))) return;

    const rawResult = (await readTextFile(filePath)).trim();
    if (!rawResult) return;

    const result = truncateResultForContext(rawResult, filePath);
    const importedAt = new Date().toISOString();
    const record: DelegationResultRecord = {
      jobId: job.jobId,
      jobDir: job.jobDir,
      importedAt,
      resultPreview: result.slice(0, 1_000),
    };

    state.importedJobs.add(job.jobId);
    stopWatching(state, job.jobId);
    pi.appendEntry(SUB_CUSTOM_RESULT, record);
    pi.sendMessage(
      {
        customType: SUB_CUSTOM_RESULT,
        content: buildParentFollowUp(job.jobId, result),
        display: false,
        details: record,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const timer = setInterval(() => {
    void check().catch(() => {
      // Keep polling; transient reads can happen while the child is writing atomically.
    });
  }, WATCH_INTERVAL_MS);
  state.watchers.set(job.jobId, timer);
  void check();
}

function stopWatching(state: RuntimeState, jobId: string): void {
  const timer = state.watchers.get(jobId);
  if (timer) clearInterval(timer);
  state.watchers.delete(jobId);
}

async function completeChildJob(jobId: string, jobDir: string, result: string): Promise<void> {
  const trimmed = result.trim();
  if (!trimmed) throw new Error("Delegation Result cannot be empty");

  await atomicWriteFile(resultPath(jobDir), `${trimmed}\n`);
  await writeJsonFile(statusPath(jobDir), {
    status: "completed",
    jobId,
    completedAt: new Date().toISOString(),
    resultPath: resultPath(jobDir),
  });
}

function getChildJobFromEnv(): { jobId: string; jobDir: string } | undefined {
  const jobId = process.env["PI_SUB_JOB_ID"];
  const jobDir = process.env["PI_SUB_JOB_DIR"];
  if (!jobId || !jobDir) return undefined;
  return { jobId, jobDir };
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

function isDelegationJobRecord(value: unknown): value is DelegationJobRecord {
  return (
    isObject(value) &&
    typeof value["jobId"] === "string" &&
    typeof value["jobDir"] === "string" &&
    typeof value["prompt"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["createdAt"] === "string"
  );
}

function isDelegationResultRecord(value: unknown): value is DelegationResultRecord {
  return (
    isObject(value) &&
    typeof value["jobId"] === "string" &&
    typeof value["jobDir"] === "string" &&
    typeof value["importedAt"] === "string" &&
    typeof value["resultPreview"] === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
