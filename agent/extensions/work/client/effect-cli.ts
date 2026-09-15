import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import * as Effect from "effect/Effect";
import {
  ClientId,
  RequestId,
  decodeBranch,
  decodeOperationId,
  decodeRepository,
  decodeTopicId,
} from "../domain/index.ts";
import type { DurableOperation, OperationHandle } from "../infrastructure/rpc/index.ts";
import {
  makeStorageMaintenance,
  type StorageMaintenance,
} from "../infrastructure/storage/index.ts";
import { createWorkPaths } from "../shared/paths.ts";
import { makeWorkClientRuntime, type WorkClientRuntime } from "./effect-runtime.ts";
import { OperationWaitEnded, waitForOperationDeadline } from "./operation-adapter.ts";
import {
  loadWorkConfiguration,
  planChildTopicOperation,
  planRootTopicOperation,
} from "./topic-operation.ts";

export const EFFECT_CLI_JSON_VERSION = 2;
export const EFFECT_CLI_PROVISION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
export const EFFECT_CLI_EXIT = {
  success: 0,
  failure: 1,
  usage: 2,
  confirmationRequired: 3,
  denied: 4,
  timeout: 124,
  cancelled: 130,
} as const;

export interface EffectCliDependencies {
  readonly cwd?: string;
  readonly home?: string;
  readonly runtime?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly makeClient?: (socketPath: string) => WorkClientRuntime;
  readonly maintenance?: StorageMaintenance;
  readonly isInteractive?: boolean;
  readonly provisionTimeoutMs?: number;
  readonly prompt?: (question: string, signal?: AbortSignal) => Promise<string>;
  readonly onSignal?: (handler: () => void) => () => void;
  readonly requestId?: () => string;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

type TopicCommand = "create" | "create-child";

interface ParsedTopicCommand {
  readonly command: TopicCommand;
  readonly values: Readonly<Record<string, string>>;
  readonly json: boolean;
  readonly help: boolean;
}

type ParsedPublicCommand =
  | { readonly family: "operation"; readonly command: "list"; readonly json: boolean }
  | {
      readonly family: "operation";
      readonly command: "show";
      readonly id: string;
      readonly json: boolean;
    }
  | {
      readonly family: "operation";
      readonly command: "cancel";
      readonly id: string;
      readonly json: boolean;
    }
  | { readonly family: "storage"; readonly command: "backup"; readonly json: boolean }
  | {
      readonly family: "storage";
      readonly command: "verify";
      readonly path: string;
      readonly json: boolean;
    }
  | {
      readonly family: "storage";
      readonly command: "restore";
      readonly path: string;
      readonly json: boolean;
    };

/** Production CLI adapter for durable Operation Handles and direct storage maintenance. */
export async function runEffectPiWorkCli(
  argv: readonly string[],
  dependencies: EffectCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const jsonRequested = argv.includes("--json");
  const emit = (value: Record<string, unknown>) =>
    stdout(`${JSON.stringify({ version: EFFECT_CLI_JSON_VERSION, ...value })}\n`);

  let topicCommand: ParsedTopicCommand | undefined;
  if (argv[0] === "topic" || argv[0] === "--help" || argv[0] === "-h") {
    try {
      topicCommand = parseTopicCommand(argv);
    } catch (error) {
      const message = errorMessage(error, "Invalid Topic command arguments.");
      diagnostic(stderr, `pi-work: ${message}\n${topicUsage()}`);
      if (jsonRequested) emit({ status: "error", code: "usage", message });
      return EFFECT_CLI_EXIT.usage;
    }
    if (topicCommand.help) {
      stdout(topicUsage());
      return EFFECT_CLI_EXIT.success;
    }
  }

  let publicCommand: ParsedPublicCommand | undefined;
  if (topicCommand === undefined) {
    try {
      publicCommand = parsePublicCommand(argv);
    } catch (error) {
      const message = bounded(errorMessage(error, "Invalid command arguments."));
      diagnostic(stderr, `pi-work: ${message}\n`);
      if (jsonRequested) emit({ status: "error", code: "usage", message });
      return EFFECT_CLI_EXIT.usage;
    }
  }

  const json = topicCommand?.json ?? publicCommand?.json ?? jsonRequested;
  const home = dependencies.home ?? homedir();
  let publicCommandController: AbortController | undefined;
  try {
    const paths = createWorkPaths({
      home,
      ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    });
    const makeClient =
      dependencies.makeClient ?? ((socketPath: string) => makeWorkClientRuntime({ socketPath }));

    if (topicCommand !== undefined) {
      return await runTopicCommand(topicCommand, paths, makeClient, dependencies, emit, stderr);
    }

    const command = publicCommand!;
    const controller = new AbortController();
    publicCommandController = controller;
    const removeSignal = (dependencies.onSignal ?? defaultSignalHandler)(() => controller.abort());
    try {
      if (command.family === "operation") {
        const client = makeClient(paths.socket);
        try {
          if (command.command === "list") {
            const operations = [
              ...(await abortable(client.snapshot(), controller.signal)).durable.operations,
            ].sort(
              (left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
            );
            if (json) emit({ status: "ok", operations });
            else if (operations.length === 0) stdout("No Durable Operations.\n");
            else for (const operation of operations) stdout(operationSummary(operation));
            return EFFECT_CLI_EXIT.success;
          }

          const id = decodeOperationId(command.id);
          if (command.command === "show") {
            const operation = await abortable(client.getOperation(id), controller.signal);
            if (json) emit({ status: "ok", operation });
            else stdout(operationDetail(operation));
            return EFFECT_CLI_EXIT.success;
          }

          const authority = await abortable(
            client.requestOperationCancellation(id, 60_000),
            controller.signal,
          );
          const operation = await abortable(
            client.confirmOperation(id, authority.confirmation),
            controller.signal,
          );
          const outcome = cancellationOutcome(operation);
          if (json) emit({ status: outcome.status, operation });
          else if (outcome.exit === EFFECT_CLI_EXIT.success) stdout(`${outcome.message}\n`);
          else diagnostic(stderr, `pi-work: ${outcome.message}\n`);
          return outcome.exit;
        } finally {
          await client.dispose();
        }
      }

      const maintenance =
        dependencies.maintenance ??
        makeStorageMaintenance({
          databasePath: join(paths.root, "work.db"),
          configurationPath: paths.config,
          backupsPath: join(paths.root, "backups"),
          daemonLockPath: join(
            dependencies.runtime ?? process.env["XDG_RUNTIME_DIR"]!,
            "pi-workd.lock",
          ),
        });
      if (command.command === "backup") {
        const result = await Effect.runPromise(
          maintenance.backup({ kind: "daily", sourceIdentity: "pi-work CLI" }),
          { signal: controller.signal },
        );
        const status = result.status === "created" ? "backup-created" : "backup-not-needed";
        if (json) emit({ status, result });
        else
          stdout(
            result.path === undefined
              ? "No backup was needed.\n"
              : `Backup created: ${result.path}\n`,
          );
        return EFFECT_CLI_EXIT.success;
      }
      if (command.command === "verify") {
        const result = await Effect.runPromise(maintenance.verify(command.path), {
          signal: controller.signal,
        });
        const checks = { checksum: "ok", sqlite: "ok", schema: "ok", graph: "ok" } as const;
        if (json) emit({ status: "backup-verified", checks, result });
        else
          stdout(
            `Backup verified: ${result.path}\nChecksum: ok\nSQLite: ok\nSchema: ok\nGraph: ok\n`,
          );
        return EFFECT_CLI_EXIT.success;
      }
      const result = await Effect.runPromise(maintenance.restore(command.path), {
        signal: controller.signal,
      });
      if (json) emit({ status: "backup-restored", result });
      else stdout(`Backup restored: ${result.backupPath}\n`);
      return EFFECT_CLI_EXIT.success;
    } finally {
      removeSignal();
    }
  } catch (error) {
    const message = bounded(errorMessage(error, "The pi-work command failed."));
    diagnostic(stderr, `pi-work: ${message}\n`);
    if (json) emit({ status: "error", message, ...publicFailure(error) });
    if (error instanceof UsageError) return EFFECT_CLI_EXIT.usage;
    if (
      publicCommandController?.signal.aborted ||
      (error instanceof Error && error.name === "AbortError")
    )
      return EFFECT_CLI_EXIT.cancelled;
    const reason = failureReason(error);
    if (
      reason === "denied" ||
      reason === "expired" ||
      reason === "rejected" ||
      reason === "confirmation-expired"
    )
      return EFFECT_CLI_EXIT.denied;
    return EFFECT_CLI_EXIT.failure;
  }
}

async function runTopicCommand(
  options: ParsedTopicCommand,
  paths: ReturnType<typeof createWorkPaths>,
  makeClient: (socketPath: string) => WorkClientRuntime,
  dependencies: EffectCliDependencies,
  emit: (value: Record<string, unknown>) => void,
  stderr: (text: string) => void,
): Promise<number> {
  const json = options.json;
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const fail = (error: unknown, fallback = "Topic creation failed."): number => {
    const message = bounded(errorMessage(error, fallback));
    if (json) emit({ status: "error", message, ...publicFailure(error) });
    else diagnostic(stderr, `pi-work: ${message}\n`);
    if (error instanceof OperationWaitEnded) {
      return error.reason === "timeout" ? EFFECT_CLI_EXIT.timeout : EFFECT_CLI_EXIT.cancelled;
    }
    if (error instanceof Error && error.name === "AbortError") return EFFECT_CLI_EXIT.cancelled;
    return failureReason(error) === "denied" ? EFFECT_CLI_EXIT.denied : EFFECT_CLI_EXIT.failure;
  };

  const values = options.values;
  const cwd = dependencies.cwd ?? process.cwd();
  const requestId = RequestId.make(dependencies.requestId?.() ?? randomUUID());
  let client: WorkClientRuntime | undefined;
  let acceptedOperationId: string | undefined;
  const controller = new AbortController();
  const removeSignal = (dependencies.onSignal ?? defaultSignalHandler)(() => controller.abort());

  try {
    diagnostic(stderr, "Loading Work configuration.\n");
    const configuration = await abortable(loadWorkConfiguration(paths.config), controller.signal);
    const environment = dependencies.environment ?? process.env;
    const parentTopicId = values["parent-topic-id"] ?? environment["PI_WORK_TOPIC_ID"];
    if (options.command === "create-child") {
      if (!parentTopicId?.trim()) {
        throw new Error("--parent-topic-id is required outside a Parent Topic Main Agent session.");
      }
      decodeTopicId(parentTopicId.trim());
    }

    diagnostic(stderr, "Resolving Topic input.\n");
    const rootPlan =
      options.command === "create"
        ? await abortable(
            planRootTopicOperation(
              {
                name: values["name"]!,
                ...(values["repository"] === undefined
                  ? { sourceCheckout: values["source-checkout"] ?? cwd }
                  : { repository: values["repository"] }),
                ...(values["branch"] === undefined ? {} : { branch: values["branch"] }),
                ...(values["start-point"] === undefined
                  ? {}
                  : {
                      startPoint: values["start-point"],
                      sourceCheckout: values["source-checkout"] ?? cwd,
                    }),
              },
              configuration,
              ClientId.make(randomUUID()),
              requestId,
            ),
            controller.signal,
          )
        : undefined;

    diagnostic(stderr, "Connecting to pi-workd.\n");
    client = makeClient(paths.socket);
    const plan =
      rootPlan ??
      (await planChildTopicOperation(
        {
          name: values["name"]!,
          parentTopicId: parentTopicId!,
          startPoint: values["start-point"]!,
          sourceCheckout: values["source-checkout"] ?? cwd,
          ...(values["branch"] === undefined ? {} : { branch: values["branch"] }),
        },
        await abortable(client.snapshot(), controller.signal),
        configuration,
        client.clientId,
        requestId,
      ));

    diagnostic(stderr, "Provisioning Topic.\n");
    const handle = await abortable(client.startOperation(plan.request), controller.signal);
    acceptedOperationId = handle.id;
    let operation: DurableOperation;
    if (handle.state === "awaiting-confirmation") {
      operation = await handleConfirmation(
        handle,
        client,
        options,
        dependencies,
        controller.signal,
        emit,
        stderr,
        plan.topicId,
      );
      if (operation.state === "awaiting-confirmation") {
        return EFFECT_CLI_EXIT.confirmationRequired;
      }
      if (isTerminal(operation.state)) {
        renderTopicOperation(operation, plan.topicId, json, emit, stdout, stderr);
        return exitForOperation(operation);
      }
    }
    operation = await waitForOperationDeadline(
      client.awaitOperation(handle.id),
      handle.id,
      dependencies.provisionTimeoutMs ?? EFFECT_CLI_PROVISION_TIMEOUT_MS,
      controller.signal,
    );
    renderTopicOperation(operation, plan.topicId, json, emit, stdout, stderr);
    return exitForOperation(operation);
  } catch (error) {
    if (controller.signal.aborted && acceptedOperationId !== undefined) {
      return fail(
        new OperationWaitEnded(decodeOperationId(acceptedOperationId), "cancelled"),
        "Topic creation was cancelled.",
      );
    }
    if (controller.signal.aborted) {
      return fail(new DOMException("Topic creation was cancelled.", "AbortError"));
    }
    return fail(error);
  } finally {
    removeSignal();
    await client?.dispose();
  }
}

async function handleConfirmation(
  handle: OperationHandle,
  client: WorkClientRuntime,
  options: ParsedTopicCommand,
  dependencies: EffectCliDependencies,
  signal: AbortSignal,
  emit: (value: Record<string, unknown>) => void,
  stderr: (text: string) => void,
  topicId: string,
): Promise<DurableOperation> {
  const confirmation = handle.confirmation;
  const text = handle.confirmationText;
  if (confirmation === undefined || text === undefined) {
    throw new Error("The daemon omitted the direct confirmation request.");
  }
  const interactive =
    !options.json &&
    (dependencies.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY));
  if (!interactive) {
    const operation = await abortable(client.getOperation(handle.id), signal);
    if (options.json) {
      emit({
        status: "confirmation-required",
        operationId: handle.id,
        topicId,
        confirmationText: text,
        phase: operation.phase,
      });
    } else {
      diagnostic(stderr, `Confirmation required: ${text}\nOperation: ${handle.id}.\n`);
    }
    return operation;
  }

  diagnostic(stderr, `${bounded(text)}\n`);
  const approved = await askYesNo(dependencies.prompt ?? promptTerminal, signal);
  return approved
    ? abortable(client.confirmOperation(handle.id, confirmation), signal)
    : abortable(client.rejectOperation(handle.id), signal);
}

function parsePublicCommand(argv: readonly string[]): ParsedPublicCommand {
  const jsonCount = argv.filter((value) => value === "--json").length;
  if (jsonCount > 1) throw new UsageError("--json can be given only once.");
  const json = jsonCount === 1;
  const args = argv.filter((value) => value !== "--json");
  const family = args[0];
  const command = args[1];

  if (family === "operation") {
    if (command === "list" && args.length === 2) return { family, command, json };
    if (command === "show" && args.length === 3) {
      decodeOperationId(args[2]!);
      return { family, command, id: args[2]!, json };
    }
    if (command === "cancel") {
      if (args.length === 3) {
        throw new UsageError(
          "operation cancel requires --confirm as a direct cancellation confirmation.",
        );
      }
      if (args.length === 4 && args[3] === "--confirm") {
        decodeOperationId(args[2]!);
        return { family, command, id: args[2]!, json };
      }
    }
    throw new UsageError(
      "Expected operation list, show <operation-id>, or cancel <operation-id> --confirm.",
    );
  }

  if (family === "storage") {
    if (command === "backup" && args.length === 2) return { family, command, json };
    if (command === "verify" && args.length === 3) {
      assertExactAbsolutePath(args[2]!);
      return { family, command, path: args[2]!, json };
    }
    if (command === "restore") {
      if (args.length === 3) {
        throw new UsageError(
          "storage restore requires --confirm as a direct restore confirmation.",
        );
      }
      if (args.length === 4 && args[3] === "--confirm") {
        assertExactAbsolutePath(args[2]!);
        return { family, command, path: args[2]!, json };
      }
    }
    throw new UsageError(
      "Expected storage backup, verify <absolute-backup-path>, or restore <absolute-backup-path> --confirm.",
    );
  }

  throw new UsageError(usage());
}

function assertExactAbsolutePath(path: string): void {
  if (path.length === 0 || resolve(path) !== path) {
    throw new UsageError("Backup path must be absolute and exact.");
  }
}

function parseTopicCommand(argv: readonly string[]): ParsedTopicCommand {
  const json = argv.includes("--json");
  if (argv[0] === "--help" || argv[0] === "-h") {
    if (argv.length !== 1 && !(argv.length === 2 && json)) {
      throw new UsageError("Help does not accept Topic options.");
    }
    return { command: "create", values: {}, json, help: true };
  }
  if (argv[0] !== "topic" || (argv[1] !== "create" && argv[1] !== "create-child")) {
    throw new UsageError("Expected `topic create` or `topic create-child`.");
  }
  const command = argv[1];
  const allowed = new Set(
    command === "create"
      ? ["name", "repository", "branch", "start-point", "source-checkout"]
      : ["name", "branch", "start-point", "source-checkout", "parent-topic-id"],
  );
  const values: Record<string, string> = {};
  let seenJson = false;
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      if (seenJson) throw new UsageError("--json can be given only once.");
      seenJson = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command, values: {}, json, help: true };
    }
    if (!argument.startsWith("--")) throw new UsageError(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!allowed.has(key)) throw new UsageError(`Unknown option: ${argument}`);
    if (values[key] !== undefined) throw new UsageError(`${argument} can be given only once.`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${argument} requires a value.`);
    }
    if (value.trim().length === 0) throw new UsageError(`${argument} must not be empty.`);
    values[key] = value;
  }
  const name = values["name"]?.trim();
  if (name === undefined) throw new UsageError("--name is required.");
  if (name.length > 200) throw new UsageError("--name must contain at most 200 characters.");
  values["name"] = name;
  if (command === "create-child" && values["start-point"] === undefined) {
    throw new UsageError("--start-point is required for `topic create-child`.");
  }
  if (values["repository"] !== undefined) decodeRepository(values["repository"]);
  if (values["branch"] !== undefined) decodeBranch(values["branch"]);
  if (values["parent-topic-id"] !== undefined) decodeTopicId(values["parent-topic-id"]);
  return { command, values, json, help: false };
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

function renderTopicOperation(
  operation: DurableOperation,
  topicId: string,
  json: boolean,
  emit: (value: Record<string, unknown>) => void,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
): void {
  const status = semanticStatus(operation);
  const result = operation.result?.value;
  if (json) {
    emit({
      status,
      operationId: operation.id,
      topicId,
      phase: operation.phase,
      ...(result === undefined ? {} : { result }),
    });
  } else if (status === "succeeded") {
    stdout(`Topic operation succeeded. Operation: ${operation.id}; Topic: ${topicId}.\n`);
  } else {
    diagnostic(
      stderr,
      `pi-work: Topic operation ${status}. Operation: ${operation.id}; Topic: ${topicId}.\n`,
    );
  }
}

function semanticStatus(operation: DurableOperation): string {
  if (operation.state === "awaiting-confirmation") return "confirmation-required";
  const reason = resultReason(operation.result?.value);
  if (operation.phase === "rejected" || reason === "confirmation-rejected") return "rejected";
  if (reason === "denied") return "denied";
  if (reason === "timeout") return "timeout";
  return operation.state;
}

function exitForOperation(operation: DurableOperation): number {
  const status = semanticStatus(operation);
  if (status === "succeeded") return EFFECT_CLI_EXIT.success;
  if (status === "confirmation-required") return EFFECT_CLI_EXIT.confirmationRequired;
  if (status === "denied" || status === "rejected") return EFFECT_CLI_EXIT.denied;
  if (status === "timeout") return EFFECT_CLI_EXIT.timeout;
  if (operation.state === "cancelled") return EFFECT_CLI_EXIT.cancelled;
  return EFFECT_CLI_EXIT.failure;
}

function isTerminal(state: DurableOperation["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

interface DisplayOperation {
  readonly id: string;
  readonly topicId?: string | undefined;
  readonly state: string;
  readonly phase: string;
  readonly result?: unknown | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt?: string | undefined;
}

function operationSummary(operation: DisplayOperation): string {
  return `${operation.id}\t${operation.state}\t${operation.phase}\t${operation.updatedAt}\n`;
}

function operationDetail(operation: DisplayOperation): string {
  const lines = [
    `Operation: ${operation.id}`,
    `State: ${operation.state}`,
    `Phase: ${operation.phase}`,
    ...(operation.topicId === undefined ? [] : [`Topic: ${operation.topicId}`]),
    `Created: ${operation.createdAt}`,
    `Updated: ${operation.updatedAt}`,
    ...(operation.terminalAt === undefined ? [] : [`Terminal: ${operation.terminalAt}`]),
    ...(operation.result === undefined ? [] : [`Result: ${JSON.stringify(operation.result)}`]),
  ];
  return `${lines.join("\n")}\n`;
}

function cancellationOutcome(operation: DurableOperation): {
  readonly status: string;
  readonly message: string;
  readonly exit: number;
} {
  const reason = resultReason(operation.result?.value);
  if (operation.phase === "expired" || reason === "confirmation-expired") {
    return {
      status: "confirmation-expired",
      message: `Cancellation confirmation expired for ${operation.id}.`,
      exit: EFFECT_CLI_EXIT.denied,
    };
  }
  if (operation.phase === "rejected" || reason === "confirmation-rejected") {
    return {
      status: "confirmation-rejected",
      message: `Cancellation was rejected for ${operation.id}.`,
      exit: EFFECT_CLI_EXIT.denied,
    };
  }
  if (operation.state === "failed") {
    return {
      status: "cancellation-failed",
      message: `Cancellation failed for ${operation.id}.`,
      exit: EFFECT_CLI_EXIT.failure,
    };
  }
  if (operation.state === "succeeded") {
    return {
      status: "operation-completed",
      message: `Operation ${operation.id} completed before cancellation.`,
      exit: EFFECT_CLI_EXIT.success,
    };
  }
  if (operation.state === "cancelled") {
    return {
      status: "cancellation-completed",
      message: `Cancellation completed for ${operation.id}.`,
      exit: EFFECT_CLI_EXIT.success,
    };
  }
  return {
    status: "cancellation-requested",
    message: `Cancellation requested for ${operation.id}. Current daemon state: ${operation.state}.`,
    exit: EFFECT_CLI_EXIT.success,
  };
}

function resultReason(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "reason" in value
    ? String(value.reason)
    : undefined;
}

function publicFailure(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return {};
  const value = error as Record<string, unknown>;
  const reason = typeof value["reason"] === "string" ? bounded(value["reason"], 100) : undefined;
  const code = typeof value["code"] === "string" ? bounded(value["code"], 100) : reason;
  const details = value["details"];
  const publicDetails: Record<string, string> = {};
  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    for (const key of ["operationId", "topicId", "existingTopicId", "existingTopicName"] as const) {
      if (typeof record[key] === "string") publicDetails[key] = bounded(record[key] as string, 200);
    }
  }
  return {
    ...(code === undefined ? {} : { code }),
    ...(Object.keys(publicDetails).length === 0 ? {} : { details: publicDetails }),
  };
}

function failureReason(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    typeof error.reason === "string"
    ? error.reason
    : undefined;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException("The client wait was cancelled.", "AbortError");
  let remove = (): void => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(new DOMException("The client wait was cancelled.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    remove = () => signal.removeEventListener("abort", abort);
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    remove();
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function bounded(value: string, maximum = 1_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function diagnostic(stderr: (text: string) => void, message: string): void {
  stderr(bounded(message, 2_000));
}

function defaultSignalHandler(handler: () => void): () => void {
  process.once("SIGINT", handler);
  return () => process.off("SIGINT", handler);
}

class UsageError extends Error {}

function topicUsage(): string {
  return (
    "Usage: pi-work topic create --name <name> [--repository <owner/repo>] [--branch <branch>] [--start-point <revision>] [--source-checkout <path>] [--json]\n" +
    "       pi-work topic create-child --name <name> --start-point <revision> [--branch <branch>] [--parent-topic-id <id>] [--source-checkout <path>] [--json]\n"
  );
}

function usage(): string {
  return "Expected topic create, topic create-child, operation list/show/cancel, or storage backup/verify/restore.";
}
