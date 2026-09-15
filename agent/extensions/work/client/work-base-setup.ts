import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { AbsolutePath, ConfigurationFailure } from "../domain/index.ts";
import {
  WORK_CONFIG_VERSION,
  makeWorkConfigurationService,
  type WorkConfiguration,
} from "../infrastructure/config.ts";

export interface WorkBaseSetupUi {
  readonly input: (title: string, placeholder?: string) => Promise<string | undefined>;
  readonly notify: (message: string, level: "error") => void;
}

export interface WorkBaseFileSystem {
  readonly stat: (path: string) => Promise<{ isDirectory(): boolean }>;
  readonly access: (path: string, mode: number) => Promise<void>;
}

export interface WorkBaseValidation {
  readonly path?: AbsolutePath;
  readonly message?: string;
}

export interface WorkBaseSetupOptions {
  readonly home?: string;
  readonly fileSystem?: WorkBaseFileSystem;
}

export function expandWorkBase(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

export async function validateWorkBase(
  input: string,
  options: WorkBaseSetupOptions = {},
): Promise<WorkBaseValidation> {
  const path = expandWorkBase(input, options.home);
  if (path.length === 0) return { message: "WORK_BASE is required." };
  if (!isAbsolute(path)) return { message: "WORK_BASE must be an absolute directory path." };

  const fileSystem = options.fileSystem ?? { stat, access };
  let details: { isDirectory(): boolean };
  try {
    details = await fileSystem.stat(path);
  } catch (cause) {
    return isCode(cause, "ENOENT")
      ? { message: "WORK_BASE does not exist." }
      : { message: "WORK_BASE cannot be inspected." };
  }
  if (!details.isDirectory()) return { message: "WORK_BASE must be a directory." };
  try {
    await fileSystem.access(path, constants.W_OK);
  } catch {
    return { message: "WORK_BASE must be writable." };
  }
  return { path: AbsolutePath.make(path) };
}

/** Configures a missing Work Base. Undefined means that the human cancelled. */
export async function completeWorkBaseSetup(
  configPath: string,
  ui: WorkBaseSetupUi,
  options: WorkBaseSetupOptions = {},
): Promise<WorkConfiguration | undefined> {
  const service = await Effect.runPromise(
    makeWorkConfigurationService(configPath).pipe(Effect.provide(BunFileSystem.layer)),
  );
  let current: WorkConfiguration | undefined;
  try {
    current = await Effect.runPromise(service.validateStartup);
  } catch (cause) {
    if (!(cause instanceof ConfigurationFailure) || cause.reason !== "missing") throw cause;
  }
  if (current?.workBase !== undefined) return current;

  while (true) {
    const answer = await ui.input(
      "Set WORK_BASE",
      "Absolute directory path (~/ledger is accepted)",
    );
    if (answer === undefined) return undefined;
    const validation = await validateWorkBase(answer, options);
    if (validation.path === undefined) {
      ui.notify(validation.message ?? "WORK_BASE is invalid.", "error");
      continue;
    }
    const configured = await Effect.runPromise(
      service.write(
        current === undefined
          ? defaultWorkConfiguration(validation.path)
          : { ...current, workBase: validation.path },
      ),
    );
    await Effect.runPromise(service.validateStartup);
    return configured;
  }
}

function defaultWorkConfiguration(workBase: AbsolutePath): WorkConfiguration {
  return {
    version: WORK_CONFIG_VERSION,
    workBase,
    policies: {
      defaults: {
        "repository.clone": "allow",
        "topic.create-worktree": "allow",
        "topic.run-setup": "allow",
        "terminal.open": "allow",
        "agent.open": "allow",
        "agent.reset": "ask",
        "topic.delete": "ask",
      },
      repositories: {},
      topics: {},
    },
    repositories: {},
  };
}

function isCode(cause: unknown, code: string): boolean {
  return (
    cause !== null &&
    typeof cause === "object" &&
    "code" in cause &&
    (cause as { readonly code?: unknown }).code === code
  );
}
