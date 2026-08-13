import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ConfigStore, WorkConfig } from "../shared/index.ts";
import { ACTION_IDS, WORK_DATA_VERSION } from "../shared/index.ts";

export interface WorkBaseValidation {
  ok: boolean;
  path?: string;
  message?: string;
}

export interface WorkBaseFileSystem {
  stat(path: string): Promise<{ isDirectory(): boolean }>;
  access(path: string, mode: number): Promise<void>;
}

export function expandWorkBase(input: string, home = homedir()): string {
  const value = input.trim();
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

export async function validateWorkBase(
  input: string,
  options: { home?: string; fileSystem?: WorkBaseFileSystem } = {},
): Promise<WorkBaseValidation> {
  const path = expandWorkBase(input, options.home);
  if (!isAbsolute(path)) {
    return { ok: false, message: "WORK_BASE must be an absolute directory path." };
  }
  const fileSystem = options.fileSystem ?? { stat, access };
  try {
    const details = await fileSystem.stat(path);
    if (!details.isDirectory()) {
      return { ok: false, message: "WORK_BASE must be a directory." };
    }
    await fileSystem.access(path, constants.W_OK);
    return { ok: true, path };
  } catch {
    return { ok: false, message: "WORK_BASE must exist and be writable." };
  }
}

export function defaultWorkConfig(workBase: string): WorkConfig {
  return {
    version: WORK_DATA_VERSION,
    workBase,
    policies: {
      defaults: Object.fromEntries(
        ACTION_IDS.map((action) => [
          action,
          action === "topic.delete" || action === "agent.reset" ? "ask" : "allow",
        ]),
      ),
      repositories: {},
      topics: {},
    },
    repositories: {},
  };
}

export async function saveWorkBase(
  store: ConfigStore,
  current: WorkConfig | null,
  workBase: string,
): Promise<WorkConfig> {
  if (current === null) return store.save(defaultWorkConfig(workBase));
  return store.update((config) => ({ ...config, workBase }));
}

export interface SetupUi {
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string, level: "error"): void;
}

/** Completes first-run setup. Undefined means that the user cancelled. */
export async function completeWorkBaseSetup(
  store: ConfigStore,
  ui: SetupUi,
  options: { home?: string; fileSystem?: WorkBaseFileSystem } = {},
): Promise<WorkConfig | undefined> {
  const current = await store.load();
  if (current?.workBase !== undefined) return current;

  while (true) {
    const answer = await ui.input(
      "Set WORK_BASE",
      "Absolute directory path (~/ledger is accepted)",
    );
    if (answer === undefined) return undefined;
    const validation = await validateWorkBase(answer, options);
    if (!validation.ok || validation.path === undefined) {
      ui.notify(validation.message ?? "WORK_BASE is invalid.", "error");
      continue;
    }
    return saveWorkBase(store, current, validation.path);
  }
}
