import type { Message } from "@earendil-works/pi-ai";

export const CHILD_ENV_FLAG = "PI_SUBAGENT_CHILD";
export const MAX_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export type History = "none" | "fork";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

/** State of one child run. `exitCode === -1` means the child still runs. */
export interface ChildResult {
  label: string;
  prompt: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ChildArgsOptions {
  prompt: string;
  model?: string | undefined;
  thinking?: string | undefined;
  tools?: string[] | undefined;
  /** Parent session file to fork. Omit for a fresh, ephemeral child. */
  forkSessionFile?: string | undefined;
  /** Directory that receives the forked session. Required with `forkSessionFile`. */
  sessionDir?: string | undefined;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function newChildResult(label: string, prompt: string): ChildResult {
  return { label, prompt, exitCode: -1, messages: [], stderr: "", usage: emptyUsage() };
}

/** Builds the `pi` argument list for one headless child. */
export function buildChildArgs(options: ChildArgsOptions): string[] {
  const args = ["--mode", "json", "-p"];
  if (options.forkSessionFile) {
    if (!options.sessionDir) throw new Error("sessionDir is required when forking");
    args.push("--fork", options.forkSessionFile, "--session-dir", options.sessionDir);
  } else {
    args.push("--no-session");
  }
  if (options.model) args.push("--model", options.model);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools && options.tools.length > 0) args.push("--tools", options.tools.join(","));
  // "--" keeps a prompt that starts with "-" or "@" from being read as an option or file.
  args.push("--", options.prompt);
  return args;
}

const TOPIC_AGENT_IDENTITY_VARIABLES = [
  "PI_WORK_TOPIC_ID",
  "PI_WORK_SOCKET",
  "PI_WORK_REGISTRATION_TOKEN",
  "PI_WORK_SESSION_ID",
  "PI_WORK_AFFILIATION",
  "PI_WORK_TOPIC_NAME",
] as const;

/** Child environment: no Topic Agent identity, and the recursion guard is set. */
export function buildChildEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment = { ...parent };
  for (const variable of TOPIC_AGENT_IDENTITY_VARIABLES) delete environment[variable];
  environment[CHILD_ENV_FLAG] = "1";
  return environment;
}

/** Applies one JSON-mode event line to `result`. Returns true when `result` changed. */
export function applyEventLine(result: ChildResult, line: string): boolean {
  if (!line.trim()) return false;
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(event) || event["type"] !== "message_end" || !isRecord(event["message"])) {
    return false;
  }
  const message = event["message"] as unknown as Message;
  if ((message.role as string) === "system" || message.role === "user") return false;

  result.messages.push(message);
  if (message.role === "assistant") {
    result.usage.turns++;
    const usage = message.usage;
    if (usage) {
      result.usage.input += usage.input || 0;
      result.usage.output += usage.output || 0;
      result.usage.cacheRead += usage.cacheRead || 0;
      result.usage.cacheWrite += usage.cacheWrite || 0;
      result.usage.cost += usage.cost?.total || 0;
      result.usage.contextTokens = usage.totalTokens || 0;
    }
    if (!result.model && message.model) result.model = message.model;
    if (message.stopReason) result.stopReason = message.stopReason;
    if (message.errorMessage) result.errorMessage = message.errorMessage;
  }
  return true;
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    for (const part of message.content) if (part.type === "text") return part.text;
  }
  return "";
}

export function isFailed(result: ChildResult): boolean {
  return result.exitCode > 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: ChildResult): string {
  if (isFailed(result)) {
    return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  }
  return getFinalOutput(result.messages) || "(no output)";
}

export function truncateOutput(output: string, cap: number = PER_TASK_OUTPUT_CAP): string {
  const bytes = Buffer.from(output, "utf8");
  if (bytes.length <= cap) return output;
  const kept = bytes
    .subarray(0, cap)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  const omitted = bytes.length - Buffer.byteLength(kept, "utf8");
  return `${kept}\n\n[Output truncated: ${omitted} bytes omitted.]`;
}

export type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (part.type === "toolCall") {
        items.push({ type: "toolCall", name: part.name, args: part.arguments });
      }
    }
  }
  return items;
}

export function aggregateUsage(results: ChildResult[]): UsageStats {
  const total = emptyUsage();
  for (const { usage } of results) {
    total.input += usage.input;
    total.output += usage.output;
    total.cacheRead += usage.cacheRead;
    total.cacheWrite += usage.cacheWrite;
    total.cost += usage.cost;
    total.turns += usage.turns;
  }
  return total;
}

/** Runs `fn` over `items` with at most `concurrency` calls active. Keeps input order. */
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const results = Array.from<TOut>({ length: items.length });
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: items.length === 0 ? 0 : workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as TIn, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
