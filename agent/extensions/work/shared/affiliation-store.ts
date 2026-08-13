import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "./atomic-json.ts";
import { WorkDataError, boundMessage, isTopicId } from "./domain.ts";
import type { WorkPaths } from "./paths.ts";

const MAX_AFFILIATIONS = 1_000;
const MAX_TOKEN_LENGTH = 200;

/**
 * Durable window-affiliation credentials (`token -> topicId`). The map lets a
 * Main Agent window re-attach to its Topic after a daemon restart, so the
 * in-memory lease is rebuilt from a credential the window still holds. Values
 * are non-secret and private-permissioned like the rest of `~/work`.
 */
export interface AffiliationStore {
  load(): Promise<Map<string, string>>;
  save(entries: Map<string, string>): Promise<void>;
}

export function createAffiliationStore(paths: WorkPaths): AffiliationStore {
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

  return {
    async load() {
      let text: string;
      try {
        text = await readFile(paths.affiliations, "utf8");
      } catch (error) {
        if (isCode(error, "ENOENT")) return new Map();
        throw storageError("Cannot read work affiliations.", error);
      }
      try {
        return parseAffiliations(JSON.parse(text));
      } catch (error) {
        if (error instanceof WorkDataError) throw error;
        throw storageError("Work affiliations file is not valid JSON.", error);
      }
    },
    async save(entries) {
      return serialize(async () => {
        const affiliations: Record<string, string> = {};
        let count = 0;
        for (const [token, topicId] of entries) {
          if (count >= MAX_AFFILIATIONS) break;
          if (!isValidToken(token) || !isTopicId(topicId)) continue;
          affiliations[token] = topicId;
          count += 1;
        }
        await writeJsonAtomic(paths.affiliations, { version: 1, affiliations });
      });
    },
  };
}

function parseAffiliations(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  const affiliations = (value as Record<string, unknown>)["affiliations"];
  if (affiliations === null || typeof affiliations !== "object" || Array.isArray(affiliations)) {
    return result;
  }
  for (const [token, topicId] of Object.entries(affiliations as Record<string, unknown>)) {
    if (result.size >= MAX_AFFILIATIONS) break;
    if (isValidToken(token) && typeof topicId === "string" && isTopicId(topicId)) {
      result.set(token, topicId);
    }
  }
  return result;
}

function isValidToken(token: string): boolean {
  return token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function storageError(message: string, cause: unknown): WorkDataError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new WorkDataError("storage-error", boundMessage(`${message} ${detail}`));
}
