import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import type { WorkConfig, WorkPaths } from "../shared/index.ts";
import type { TopicMutationResult } from "../daemon/topic-service.ts";
import { createConfigStore, createWorkPaths } from "../shared/index.ts";
import { SystemdWorkdManager, defaultSystemdPaths } from "./systemd.ts";
import {
  resolveTopicCreationInput,
  type ResolvedTopicCreationInput,
  type TopicCreationInput,
} from "./topic-creation.ts";

export const CLI_OUTPUT_VERSION = 1;
export const CLI_PROVISION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export const CLI_EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
  confirmationRequired: 3,
  denied: 4,
  timeout: 124,
  cancelled: 130,
} as const;

export interface TopicCreationClient {
  createTopic(
    input: ResolvedTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  confirm(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  reject(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  close(): void;
}

export interface CliDependencies {
  cwd?: string;
  home?: string;
  runtime?: string;
  isInteractive?: boolean;
  provisionTimeoutMs?: number;
  resolveInput?: typeof resolveTopicCreationInput;
  loadConfig?: () => Promise<WorkConfig | null>;
  connect?: () => Promise<TopicCreationClient>;
  prompt?: (question: string, signal?: AbortSignal) => Promise<string>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  onSignal?: (handler: () => void) => () => void;
  requestId?: () => string;
}

interface ParsedOptions extends TopicCreationInput {
  json: boolean;
  help: boolean;
}

class CliUsageError extends Error {}

/** Run one bounded pi-work command and return its process exit code. */
export async function runPiWorkCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text) => process.stderr.write(text));
  let options: ParsedOptions;
  try {
    options = parseCliArguments(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments.";
    stderr(`pi-work: ${message}\n${usage()}`);
    return CLI_EXIT.usage;
  }

  if (options.help) {
    stdout(usage());
    return CLI_EXIT.success;
  }

  const json = options.json;
  const emitFinal = (value: Record<string, unknown>): void => {
    if (json) stdout(`${JSON.stringify({ version: CLI_OUTPUT_VERSION, ...value })}\n`);
  };
  const fail = (
    message: string,
    code: number = CLI_EXIT.failure,
    errorCode?: string,
    details?: Record<string, string>,
  ): number => {
    if (json)
      emitFinal({
        status: "error",
        ...(errorCode === undefined ? {} : { code: errorCode }),
        message,
        ...(details === undefined ? {} : { details }),
      });
    else stderr(`pi-work: ${message}\n`);
    return code;
  };

  const cwd = dependencies.cwd ?? process.cwd();
  const home = dependencies.home ?? homedir();
  let paths: WorkPaths;
  try {
    paths = createWorkPaths({
      home,
      ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    });
    const config = await (dependencies.loadConfig ?? (() => createConfigStore(paths).load()))();
    if (config?.workBase === undefined) {
      return fail(
        "WORK_BASE is not configured. Run /work in Pi to set it up.",
        CLI_EXIT.failure,
        "missing-work-base",
      );
    }
  } catch (error) {
    return fail(errorMessage(error), CLI_EXIT.failure, errorCode(error), errorDetails(error));
  }

  let resolved: ResolvedTopicCreationInput;
  try {
    diagnostic(stderr, "Resolving Topic input.");
    resolved = await (dependencies.resolveInput ?? resolveTopicCreationInput)({
      name: options.name,
      ...(options.repository === undefined ? {} : { repository: options.repository }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.startPoint === undefined ? {} : { startPoint: options.startPoint }),
      sourceCheckout: options.sourceCheckout ?? cwd,
    });
  } catch (error) {
    return fail(errorMessage(error), CLI_EXIT.failure, errorCode(error), errorDetails(error));
  }

  const interactive =
    !json && (dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const timeoutMs = dependencies.provisionTimeoutMs ?? CLI_PROVISION_TIMEOUT_MS;
  const requestId = dependencies.requestId?.() ?? randomUUID();
  let client: TopicCreationClient | undefined;
  let cancelled = false;
  let resolveCancellation = (): void => undefined;
  const cancellation = new Promise<undefined>((resolve) => {
    resolveCancellation = () => resolve(undefined);
  });
  const promptAbort = new AbortController();
  const removeSignal = (dependencies.onSignal ?? defaultSignalHandler)(() => {
    cancelled = true;
    promptAbort.abort();
    client?.close();
    resolveCancellation();
  });

  try {
    diagnostic(stderr, "Connecting to pi-workd.");
    const connecting = (
      dependencies.connect ??
      (() =>
        new SystemdWorkdManager({
          paths: defaultSystemdPaths(home, paths.socket),
          clientId: randomUUID(),
        }).ensureConnected())
    )();
    void connecting
      .then((connected) => {
        if (cancelled) connected.close();
      })
      .catch(() => undefined);
    client = await Promise.race([connecting, cancellation]);
    if (client === undefined) {
      return fail("Topic creation was cancelled.", CLI_EXIT.cancelled, "cancelled");
    }

    diagnostic(stderr, "Provisioning Topic.");
    let result = await client.createTopic(resolved, requestId, timeoutMs);
    while (result.status === "confirmation-required") {
      if (!interactive) {
        renderConfirmation(result, json, stdout, stderr);
        return CLI_EXIT.confirmationRequired;
      }
      stderr(`${result.text}\n`);
      const approved = await askYesNo(dependencies.prompt ?? promptTerminal, promptAbort.signal);
      if (!approved) {
        const rejected = await client.reject(
          result.token,
          `${requestId}:reject:${result.action}`,
          timeoutMs,
        );
        if (rejected.status === "confirmation-required") {
          throw new Error("Work daemon returned confirmation after rejection.");
        }
        renderTerminal(rejected, json, stdout, stderr);
        return exitForResult(rejected);
      }
      result = await client.confirm(
        result.token,
        `${requestId}:confirm:${result.action}`,
        timeoutMs,
      );
    }

    renderTerminal(result, json, stdout, stderr);
    return exitForResult(result);
  } catch (error) {
    if (cancelled) return fail("Topic creation was cancelled.", CLI_EXIT.cancelled, "cancelled");
    const message = errorMessage(error);
    const timedOut = /timed out/i.test(message);
    return fail(
      message,
      timedOut ? CLI_EXIT.timeout : CLI_EXIT.failure,
      errorCode(error),
      errorDetails(error),
    );
  } finally {
    removeSignal();
    client?.close();
  }
}

function parseCliArguments(argv: readonly string[]): ParsedOptions {
  if (argv[0] === "--help" || argv[0] === "-h") return { name: "", json: false, help: true };
  if (argv[0] !== "topic" || argv[1] !== "create") {
    throw new CliUsageError("Expected `topic create`.");
  }
  const values: Record<string, string> = {};
  let json = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      if (json) throw new CliUsageError("--json can be given only once.");
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { name: "", json, help: true };
    const key = FLAG_NAMES[argument];
    if (key === undefined) throw new CliUsageError(`Unknown option: ${argument}`);
    if (values[key] !== undefined) throw new CliUsageError(`${argument} can be given only once.`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new CliUsageError(`${argument} requires a value.`);
    }
    values[key] = value;
  }
  if (values["name"] === undefined) throw new CliUsageError("--name is required.");
  return {
    name: values["name"],
    ...(values["repository"] === undefined ? {} : { repository: values["repository"] }),
    ...(values["branch"] === undefined ? {} : { branch: values["branch"] }),
    ...(values["startPoint"] === undefined ? {} : { startPoint: values["startPoint"] }),
    ...(values["sourceCheckout"] === undefined ? {} : { sourceCheckout: values["sourceCheckout"] }),
    json,
    help: false,
  };
}

const FLAG_NAMES: Readonly<Record<string, string>> = {
  "--name": "name",
  "--repository": "repository",
  "--branch": "branch",
  "--start-point": "startPoint",
  "--source-checkout": "sourceCheckout",
};

function usage(): string {
  return "Usage: pi-work topic create --name <name> [--repository <owner/repo>] [--branch <branch>] [--start-point <revision>] [--source-checkout <path>] [--json]\n";
}

async function askYesNo(
  prompt: (question: string, signal?: AbortSignal) => Promise<string>,
  signal: AbortSignal,
): Promise<boolean> {
  while (true) {
    const answer = (await prompt("Approve? [yes/no] ", signal)).trim().toLowerCase();
    if (answer === "yes" || answer === "y") return true;
    if (answer === "no" || answer === "n") return false;
  }
}

async function promptTerminal(question: string, signal?: AbortSignal): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await input.question(question, signal === undefined ? {} : { signal });
  } finally {
    input.close();
  }
}

function renderConfirmation(
  result: Extract<TopicMutationResult, { status: "confirmation-required" }>,
  json: boolean,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): void {
  const value = {
    version: CLI_OUTPUT_VERSION,
    status: result.status,
    action: result.action,
    topicId: result.topicId,
    text: result.text,
    expiresAt: result.expiresAt,
  };
  if (json) stdout(`${JSON.stringify(value)}\n`);
  else stderr(`Confirmation required: ${result.text}\n`);
}

function renderTerminal(
  result: Exclude<TopicMutationResult, { status: "confirmation-required" }>,
  json: boolean,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): void {
  if (result.status === "ready") {
    const topic = result.topic;
    const value = {
      version: CLI_OUTPUT_VERSION,
      status: "ready",
      topicId: topic.id,
      name: topic.name,
      repository: topic.repository,
      branch: topic.branch,
      setupState: topic.setup.state,
      worktreePath: topic.worktreePath,
    };
    if (json) stdout(`${JSON.stringify(value)}\n`);
    else {
      stdout(
        `Topic ready: ${topic.name}\nID: ${topic.id}\nRepository: ${topic.repository}\nBranch: ${topic.branch}\nSetup: ${topic.setup.state}\nWorktree: ${topic.worktreePath ?? "unavailable"}\n`,
      );
    }
    return;
  }

  const reason = "reason" in result ? result.reason : `Topic creation ${result.status}.`;
  const value = {
    version: CLI_OUTPUT_VERSION,
    status: result.status,
    ...(result.status === "rejected" ? { topicId: result.topicId } : {}),
    ...(result.status !== "rejected" &&
    result.status !== "deleted" &&
    "code" in result &&
    result.code !== undefined
      ? { code: result.code }
      : {}),
    message: reason,
  };
  if (json) stdout(`${JSON.stringify(value)}\n`);
  else stderr(`pi-work: ${reason}\n`);
}

function exitForResult(
  result: Exclude<TopicMutationResult, { status: "confirmation-required" }>,
): number {
  if (result.status === "ready") return CLI_EXIT.success;
  if (result.status === "timeout") return CLI_EXIT.timeout;
  if (result.status === "cancelled") return CLI_EXIT.cancelled;
  if (result.status === "denied" || result.status === "rejected") return CLI_EXIT.denied;
  return CLI_EXIT.failure;
}

function diagnostic(stderr: (text: string) => void, message: string): void {
  stderr(`${message}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected pi-work failure.";
}

function errorCode(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function errorDetails(error: unknown): Record<string, string> | undefined {
  if (error === null || typeof error !== "object" || !("details" in error)) return undefined;
  const value = error.details;
  if (value === null || typeof value !== "object") return undefined;
  const details = value as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of ["existingTopicId", "existingTopicName"] as const) {
    const value = key in details ? details[key] : undefined;
    if (typeof value === "string") result[key] = value;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function defaultSignalHandler(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}
