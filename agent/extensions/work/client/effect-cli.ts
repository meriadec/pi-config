import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { RequestId, decodeOperationId } from "../domain/index.ts";
import {
  makeStorageMaintenance,
  type StorageMaintenance,
} from "../infrastructure/storage/index.ts";
import { createWorkPaths } from "../shared/paths.ts";
import { makeWorkClientRuntime, type WorkClientRuntime } from "./effect-runtime.ts";
import { OperationWaitEnded, startAndWaitForOperation } from "./operation-adapter.ts";
import {
  loadWorkConfiguration,
  planChildTopicOperation,
  planRootTopicOperation,
} from "./topic-operation.ts";

export const EFFECT_CLI_JSON_VERSION = 2;

export interface EffectCliDependencies {
  readonly cwd?: string;
  readonly home?: string;
  readonly runtime?: string;
  readonly environment?: Record<string, string | undefined>;
  readonly makeClient?: (socketPath: string) => WorkClientRuntime;
  readonly maintenance?: StorageMaintenance;
  readonly writeStdout?: (text: string) => void;
  readonly writeStderr?: (text: string) => void;
}

/** New production-independent CLI adapter for Operation Handles and direct storage maintenance. */
export async function runEffectPiWorkCli(
  argv: readonly string[],
  dependencies: EffectCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.writeStdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.writeStderr ?? ((text: string) => process.stderr.write(text));
  const json = argv.includes("--json");
  const args = argv.filter((value) => value !== "--json");
  const emit = (value: Record<string, unknown>) =>
    stdout(`${JSON.stringify({ version: EFFECT_CLI_JSON_VERSION, ...value })}\n`);
  const home = dependencies.home ?? homedir();
  let paths: ReturnType<typeof createWorkPaths>;
  try {
    paths = createWorkPaths({
      home,
      ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
    });
    const makeClient =
      dependencies.makeClient ?? ((socketPath: string) => makeWorkClientRuntime({ socketPath }));
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

    if (args[0] === "operation") {
      const client = makeClient(paths.socket);
      try {
        if (args[1] === "list" && args.length === 2) {
          const operations = (await client.snapshot()).durable.operations;
          if (json) emit({ status: "ok", operations });
          else
            for (const operation of operations)
              stdout(`${operation.id}\t${operation.state}\t${operation.phase}\n`);
          return 0;
        }
        if (args[1] === "show" && args[2] !== undefined && args.length === 3) {
          const operation = await client.getOperation(decodeOperationId(args[2]));
          if (json) emit({ status: "ok", operation });
          else stdout(`${JSON.stringify(operation, null, 2)}\n`);
          return 0;
        }
        if (args[1] === "cancel" && args[2] !== undefined) {
          if (!args.includes("--confirm")) {
            throw new UsageError(
              "operation cancel requires --confirm as a direct cancellation confirmation.",
            );
          }
          const id = decodeOperationId(args[2]);
          const { confirmation } = await client.requestOperationCancellation(id, 60_000);
          const operation = await client.confirmOperation(id, confirmation);
          if (json) emit({ status: "ok", operation });
          else
            stdout(`Cancellation requested for ${id}. Current daemon state: ${operation.state}.\n`);
          return 0;
        }
        throw new UsageError(
          "Expected operation list, show <operation-id>, or cancel <operation-id> --confirm.",
        );
      } finally {
        await client.dispose();
      }
    }

    if (args[0] === "storage") {
      if (args[1] === "backup" && args.length === 2) {
        const result = await Effect.runPromise(
          maintenance.backup({ kind: "daily", sourceIdentity: "pi-work CLI" }),
        );
        if (json) emit({ status: "ok", result });
        else
          stdout(
            result.path === undefined
              ? "No backup was needed.\n"
              : `Backup created: ${result.path}\n`,
          );
        return 0;
      }
      if (args[1] === "verify" && args[2] !== undefined && args.length === 3) {
        const result = await Effect.runPromise(maintenance.verify(args[2]));
        if (json) emit({ status: "ok", result });
        else stdout(`Backup verified: ${result.path}\n`);
        return 0;
      }
      if (
        args[1] === "restore" &&
        args[2] !== undefined &&
        args.length === 4 &&
        args[3] === "--confirm"
      ) {
        const result = await Effect.runPromise(maintenance.restore(args[2]));
        if (json) emit({ status: "ok", result });
        else stdout(`Backup restored: ${result.backupPath}\n`);
        return 0;
      }
      throw new UsageError(
        "Expected storage backup, verify <backup-path>, or restore <backup-path> --confirm.",
      );
    }

    if (args[0] === "topic" && (args[1] === "create" || args[1] === "create-child")) {
      const values = parseFlags(args.slice(2));
      const name = required(values, "name");
      const cwd = dependencies.cwd ?? process.cwd();
      const client = makeClient(paths.socket);
      const configuration = await loadWorkConfiguration(paths.config);
      const requestId = RequestId.make(randomUUID());
      const plan =
        args[1] === "create"
          ? await planRootTopicOperation(
              {
                name,
                sourceCheckout: values["source-checkout"] ?? cwd,
                ...(values["repository"] === undefined ? {} : { repository: values["repository"] }),
                ...(values["branch"] === undefined ? {} : { branch: values["branch"] }),
                ...(values["start-point"] === undefined
                  ? {}
                  : { startPoint: values["start-point"] }),
              },
              configuration,
              client.clientId,
              requestId,
            )
          : await planChildTopicOperation(
              {
                name,
                parentTopicId:
                  values["parent-topic-id"] ?? dependencies.environment?.["PI_WORK_TOPIC_ID"] ?? "",
                ...(values["branch"] === undefined ? {} : { branch: values["branch"] }),
                startPoint: required(values, "start-point"),
                sourceCheckout: values["source-checkout"] ?? cwd,
              },
              await client.snapshot(),
              configuration,
              client.clientId,
              requestId,
            );
      const operation = await startAndWaitForOperation({ client, request: plan.request });
      const value = operation.result?.value;
      if (json)
        emit({
          status: operation.state,
          operationId: operation.id,
          topicId: plan.topicId,
          result: value,
        });
      else
        stdout(
          `Topic operation ${operation.state}. Operation: ${operation.id}; Topic: ${plan.topicId}.\n`,
        );
      return operation.state === "succeeded" ? 0 : operation.state === "cancelled" ? 130 : 1;
    }

    throw new UsageError(usage());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The pi-work command failed.";
    if (json) emit({ status: "error", message });
    else stderr(`pi-work: ${message}\n`);
    if (error instanceof UsageError) return 2;
    if (error instanceof OperationWaitEnded) return error.reason === "timeout" ? 124 : 130;
    return 1;
  }
}

class UsageError extends Error {}

function parseFlags(args: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      !flag.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new UsageError("Topic options must be --name value pairs.");
    }
    values[flag.slice(2)] = value;
  }
  return values;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new UsageError(`--${key} is required.`);
  return value;
}

function usage(): string {
  return "Expected topic create, topic create-child, operation list/show/cancel, or storage backup/verify/restore.";
}
