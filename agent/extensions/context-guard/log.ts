import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type GuardMode = "shadow" | "live" | "off";

export const LOG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../analytics/data/context-guard.jsonl",
);

export function parseMode(value: string | undefined): GuardMode {
  const v = value?.trim().toLowerCase();
  return v === "live" || v === "off" ? v : "shadow";
}

export function newSessionId(): string {
  return randomBytes(6).toString("hex");
}

/** Append one JSON line. Never throws; returns false on failure. */
export function appendRecord(record: Record<string, unknown>, path: string = LOG_PATH): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
    return true;
  } catch {
    return false;
  }
}
