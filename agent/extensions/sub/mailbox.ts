import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const SUB_CUSTOM_JOB = "sub-delegation-job";
export const SUB_CUSTOM_RESULT = "sub-delegation-result";

export type DelegationJobStatus =
  | "created"
  | "launched"
  | "thinking"
  | "waiting"
  | "completed"
  | "launch-failed";

export interface DelegationJobStatusRecord {
  status: DelegationJobStatus;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  parentSessionFile: string | null;
  handoffMode: "fresh" | "fork";
  skillName?: string;
  forkSessionFile?: string;
  launchedAt?: string;
  thinkingAt?: string;
  waitingAt?: string;
  completedAt?: string;
  failedAt?: string;
  resultPath?: string;
  error?: string;
}

export interface DelegationJobRecord {
  jobId: string;
  jobDir: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  /** Exact Pi session that owns result import. Missing only on legacy records. */
  parentSessionId?: string;
  /** Distinguishes forks and replacement sessions. Missing only on legacy records. */
  parentSessionFile?: string | null;
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

export function getSubRoot(): string {
  return path.join(os.homedir(), CONFIG_DIR_NAME, "sub");
}

export function getJobDir(jobId: string): string {
  return path.join(getSubRoot(), "jobs", jobId);
}

export async function ensureSubRootIgnored(): Promise<void> {
  await atomicWriteFile(path.join(getSubRoot(), ".gitignore"), "*\n");
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await withFileMutationQueue(filePath, async () => atomicWriteFileUnqueued(filePath, content));
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJobStatus(
  jobDir: string,
  record: DelegationJobStatusRecord,
): Promise<void> {
  validateDelegationJobStatusRecord(record);
  await writeJsonFile(statusPath(jobDir), record);
}

export async function readJobStatus(jobDir: string): Promise<DelegationJobStatusRecord> {
  const filePath = statusPath(jobDir);
  let value: unknown;
  try {
    value = JSON.parse(await readTextFile(filePath));
  } catch (error) {
    throw new Error(`Cannot read Delegation Job status ${filePath}: ${formatError(error)}`);
  }
  return validateDelegationJobStatusRecord(value);
}

export async function transitionJobStatus(
  jobDir: string,
  requestedStatus: Exclude<DelegationJobStatus, "created">,
  at = new Date(),
  details: Pick<DelegationJobStatusRecord, "resultPath" | "error" | "forkSessionFile"> = {},
): Promise<DelegationJobStatusRecord> {
  const filePath = statusPath(jobDir);
  return withFileMutationQueue(filePath, async () => {
    const current = validateDelegationJobStatusRecord(JSON.parse(await readTextFile(filePath)));
    const next = applyStatusTransition(current, requestedStatus, at.toISOString(), details);
    validateDelegationJobStatusRecord(next);
    await atomicWriteFileUnqueued(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  });
}

export function validateDelegationJobStatusRecord(value: unknown): DelegationJobStatusRecord {
  if (!isObject(value)) throw new Error("Delegation Job status must be an object");

  const status = value["status"];
  if (!isDelegationJobStatus(status)) throw new Error(`Invalid Delegation Job status: ${status}`);
  requireString(value, "jobId");
  requireTimestamp(value, "createdAt");
  requireTimestamp(value, "updatedAt");
  if (value["parentSessionFile"] !== null && typeof value["parentSessionFile"] !== "string") {
    throw new Error("Delegation Job status parentSessionFile must be a string or null");
  }
  if (value["handoffMode"] !== "fresh" && value["handoffMode"] !== "fork") {
    throw new Error("Delegation Job status handoffMode must be fresh or fork");
  }

  const timestampForStatus: Partial<Record<DelegationJobStatus, keyof DelegationJobStatusRecord>> =
    {
      launched: "launchedAt",
      thinking: "thinkingAt",
      waiting: "waitingAt",
      completed: "completedAt",
      "launch-failed": "failedAt",
    };
  const timestamp = timestampForStatus[status];
  if (timestamp) requireTimestamp(value, timestamp);
  if (status === "completed") requireString(value, "resultPath");
  if (status === "launch-failed") requireString(value, "error");
  for (const key of ["launchedAt", "thinkingAt", "waitingAt", "completedAt", "failedAt"] as const) {
    if (value[key] !== undefined) requireTimestamp(value, key);
  }
  for (const key of ["skillName", "forkSessionFile", "resultPath", "error"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`Delegation Job status ${key} must be a string`);
    }
  }

  return value as unknown as DelegationJobStatusRecord;
}

export async function completeDelegationJob(
  jobId: string,
  jobDir: string,
  result: string,
  at = new Date(),
): Promise<DelegationJobStatusRecord> {
  const trimmed = result.trim();
  if (!trimmed) throw new Error("Delegation Result cannot be empty");

  await atomicWriteFile(resultPath(jobDir), `${trimmed}\n`);
  const status = await transitionJobStatus(jobDir, "completed", at, {
    resultPath: resultPath(jobDir),
  });
  if (status.jobId !== jobId) {
    throw new Error(`Delegation Job status belongs to ${status.jobId}, not ${jobId}`);
  }
  return status;
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

function applyStatusTransition(
  current: DelegationJobStatusRecord,
  requestedStatus: Exclude<DelegationJobStatus, "created">,
  at: string,
  details: Pick<DelegationJobStatusRecord, "resultPath" | "error" | "forkSessionFile">,
): DelegationJobStatusRecord {
  if (current.status === "launch-failed") return current;
  if (current.status === "completed") {
    return requestedStatus === "launched" ? { ...current, launchedAt: at, updatedAt: at } : current;
  }
  if (requestedStatus === "launch-failed" && current.status !== "created") return current;

  const timestamps: Partial<DelegationJobStatusRecord> = {};
  if (requestedStatus === "launched") timestamps.launchedAt = at;
  if (requestedStatus === "thinking") timestamps.thinkingAt = at;
  if (requestedStatus === "waiting") timestamps.waitingAt = at;
  if (requestedStatus === "completed") timestamps.completedAt = at;
  if (requestedStatus === "launch-failed") timestamps.failedAt = at;

  // The child can start before the parent finishes recording launch. Keep the newer child state.
  const status =
    requestedStatus === "launched" && current.status !== "created"
      ? current.status
      : requestedStatus;

  return {
    ...current,
    ...details,
    ...timestamps,
    status,
    updatedAt: at,
  };
}

async function atomicWriteFileUnqueued(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmpPath, filePath);
  } finally {
    await fs.rm(tmpPath, { force: true });
  }
}

function isDelegationJobStatus(value: unknown): value is DelegationJobStatus {
  return (
    value === "created" ||
    value === "launched" ||
    value === "thinking" ||
    value === "waiting" ||
    value === "completed" ||
    value === "launch-failed"
  );
}

function requireString(value: Record<string, unknown>, key: string): void {
  if (typeof value[key] !== "string" || value[key].length === 0) {
    throw new Error(`Delegation Job status ${key} must be a non-empty string`);
  }
}

function requireTimestamp(value: Record<string, unknown>, key: string): void {
  requireString(value, key);
  if (Number.isNaN(Date.parse(value[key] as string))) {
    throw new Error(`Delegation Job status ${key} must be an ISO timestamp`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
