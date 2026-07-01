import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const SUB_CUSTOM_JOB = "sub-delegation-job";
export const SUB_CUSTOM_RESULT = "sub-delegation-result";

export interface DelegationJobRecord {
  jobId: string;
  jobDir: string;
  prompt: string;
  cwd: string;
  createdAt: string;
}

export interface DelegationResultRecord {
  jobId: string;
  jobDir: string;
  importedAt: string;
  resultPreview: string;
}

export interface ContextPacket {
  jobId: string;
  createdAt: string;
  cwd: string;
  handoffMode: "fresh" | "fork";
  skillName?: string;
  sessionFile?: string;
  sessionName?: string;
  leafId?: string | null;
  model?: string;
  activeTools: string[];
  contextUsage?: unknown;
  contextFilePaths: string[];
}

export function buildJobId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
}

export function getSubRoot(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "sub");
}

export function getJobDir(cwd: string, jobId: string): string {
  return path.join(getSubRoot(cwd), "jobs", jobId);
}

export async function ensureSubRootIgnored(cwd: string): Promise<void> {
  await atomicWriteFile(path.join(getSubRoot(cwd), ".gitignore"), "*\n");
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await withFileMutationQueue(filePath, async () => {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readTextFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf8");
}

export function resultPath(jobDir: string): string {
  return path.join(jobDir, "result.md");
}

export function statusPath(jobDir: string): string {
  return path.join(jobDir, "status.json");
}

export function requestPath(jobDir: string): string {
  return path.join(jobDir, "request.md");
}

export function contextPath(jobDir: string): string {
  return path.join(jobDir, "context.json");
}

export function childPromptPath(jobDir: string): string {
  return path.join(jobDir, "child-system-prompt.md");
}
