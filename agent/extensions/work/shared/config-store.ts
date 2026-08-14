import { readFile } from "node:fs/promises";
import { ACTION_IDS, WorkDataError, boundMessage, parseWorkConfig } from "./domain.ts";
import type { ActionPolicyMap, WorkConfig } from "./domain.ts";
import { writeJsonAtomic } from "./atomic-json.ts";
import type { WorkPaths } from "./paths.ts";

export interface ConfigStore {
  load(): Promise<WorkConfig | null>;
  save(config: WorkConfig): Promise<WorkConfig>;
  update(change: (config: WorkConfig) => WorkConfig | Promise<WorkConfig>): Promise<WorkConfig>;
}

export function createConfigStore(paths: WorkPaths): ConfigStore {
  let pending: Promise<void> = Promise.resolve();
  const serialize = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = pending;
    let release = (): void => undefined;
    pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };

  const read = async (): Promise<{ config: WorkConfig; raw: Record<string, unknown> } | null> => {
    let text: string;
    try {
      text = await readFile(paths.config, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw storageError("Cannot read work configuration.", error);
    }
    try {
      const raw: unknown = JSON.parse(text);
      const config = parseWorkConfig(raw);
      return { config, raw: raw as Record<string, unknown> };
    } catch (error) {
      if (error instanceof WorkDataError) throw error;
      throw storageError("Work configuration is not valid JSON.", error);
    }
  };

  return {
    async load() {
      return (await read())?.config ?? null;
    },
    async save(config) {
      return serialize(async () => {
        const validated = parseWorkConfig(config);
        const current = await read();
        await writeJsonAtomic(paths.config, mergeConfig(current?.raw, validated));
        return validated;
      });
    },
    async update(change) {
      return serialize(async () => {
        const current = await read();
        if (current === null)
          throw new WorkDataError("missing-config", "Work configuration does not exist.");
        const changed = parseWorkConfig(await change(current.config));
        await writeJsonAtomic(paths.config, mergeConfig(current.raw, changed));
        return changed;
      });
    },
  };
}

function mergeConfig(
  raw: Record<string, unknown> | undefined,
  config: WorkConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw, version: config.version };
  if (config.workBase === undefined) delete result["workBase"];
  else result["workBase"] = config.workBase;
  const rawPolicies = record(raw?.["policies"]);
  result["policies"] = {
    ...rawPolicies,
    defaults: mergePolicyMap(record(rawPolicies["defaults"]), config.policies.defaults),
    repositories: mergeOverrideMaps(
      config.policies.repositories,
      record(rawPolicies["repositories"]),
    ),
    topics: mergeOverrideMaps(config.policies.topics, record(rawPolicies["topics"])),
  };
  if (Object.keys(config.repositories).length === 0) delete result["repositories"];
  else result["repositories"] = mergeRecipes(record(raw?.["repositories"]), config.repositories);
  return result;
}

function mergeRecipes(
  raw: Record<string, unknown>,
  current: Record<string, { setupCommands: string[]; basePath?: string }>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(current).map(([key, recipe]) => {
      const merged: Record<string, unknown> = {
        ...record(raw[key]),
        setupCommands: [...recipe.setupCommands],
      };
      if (recipe.basePath === undefined) delete merged["basePath"];
      else merged["basePath"] = recipe.basePath;
      return [key, merged];
    }),
  );
}

function mergeOverrideMaps(
  current: Record<string, ActionPolicyMap>,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(current).map(([key, policies]) => [
      key,
      mergePolicyMap(record(raw[key]), policies),
    ]),
  );
}

function mergePolicyMap(
  raw: Record<string, unknown>,
  current: ActionPolicyMap,
): Record<string, unknown> {
  const result = { ...raw };
  for (const action of ACTION_IDS) delete result[action];
  return Object.assign(result, current);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function storageError(message: string, cause: unknown): WorkDataError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new WorkDataError("storage-error", boundMessage(`${message} ${detail}`));
}
