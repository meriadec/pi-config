import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type DelegationJobRecord,
  type DelegationResultRecord,
  SUB_CUSTOM_JOB,
  SUB_CUSTOM_RESULT,
  readJobStatus,
  readTextFile,
  resultPath,
} from "./mailbox.ts";
import { buildParentFollowUp } from "./prompts.ts";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_DIAGNOSTICS_PER_JOB = 3;
const MAX_DIAGNOSTIC_LENGTH = 300;

export interface ParentSessionIdentity {
  sessionId: string;
  sessionFile: string | null;
}

export interface ParentMailboxTimer {
  setInterval(handler: () => void | Promise<void>, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface ParentMailboxDependencies {
  identity: ParentSessionIdentity;
  appendImport(record: DelegationResultRecord): void;
  deliverFollowUp(record: DelegationResultRecord, content: string): void;
  readResult(job: DelegationJobRecord): Promise<string | undefined>;
  readLegacyParentSessionFile(job: DelegationJobRecord): Promise<string | null>;
  now(): Date;
  timers: ParentMailboxTimer;
  diagnostic(message: string): void;
  truncateResult(result: string, fullResultPath: string): string;
  pollIntervalMs?: number;
}

/** Coordinates durable Job Mailbox imports for one exact parent Pi session. */
export class ParentMailboxCoordinator {
  private readonly watchers = new Map<string, unknown>();
  private readonly importedJobs = new Set<string>();
  private readonly deliveredRecords = new Map<string, DelegationResultRecord>();
  private readonly checkingJobs = new Set<string>();
  private readonly pendingOwnership = new Set<string>();
  private readonly diagnosticCounts = new Map<string, number>();
  private stopped = false;

  private readonly dependencies: ParentMailboxDependencies;

  constructor(dependencies: ParentMailboxDependencies) {
    this.dependencies = dependencies;
  }

  async restore(entries: unknown[]): Promise<void> {
    this.stop();
    this.stopped = false;
    this.importedJobs.clear();
    this.deliveredRecords.clear();
    this.checkingJobs.clear();
    this.pendingOwnership.clear();
    this.diagnosticCounts.clear();

    const jobs = new Map<string, DelegationJobRecord>();
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      if (entry["type"] === "custom" && entry["customType"] === SUB_CUSTOM_RESULT) {
        const record = parseDelegationResultRecord(entry["data"]);
        if (record) this.importedJobs.add(record.jobId);
        continue;
      }
      if (entry["type"] === "custom" && entry["customType"] === SUB_CUSTOM_JOB) {
        const job = parseDelegationJobRecord(entry["data"]);
        if (job) jobs.set(job.jobId, job);
        continue;
      }
      if (entry["type"] === "custom_message" && entry["customType"] === SUB_CUSTOM_RESULT) {
        const record = parseDelegationResultRecord(entry["details"]);
        if (record) this.deliveredRecords.set(record.jobId, record);
      }
    }

    for (const job of jobs.values()) {
      if (!this.importedJobs.has(job.jobId)) await this.watch(job);
    }
  }

  async watch(job: DelegationJobRecord): Promise<void> {
    if (this.stopped || this.watchers.has(job.jobId) || this.importedJobs.has(job.jobId)) return;
    const ownership = await this.ownership(job);
    if (this.stopped || ownership === "foreign") return;

    this.jobsByWatcher.set(job.jobId, job);
    if (ownership === "retry") this.pendingOwnership.add(job.jobId);
    const timer = this.dependencies.timers.setInterval(
      () => this.pollWatchedJob(job.jobId),
      this.dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    );
    this.watchers.set(job.jobId, timer);
    if (ownership === "owned") await this.pollJob(job);
  }

  async pollNow(): Promise<void> {
    const jobs = [...this.watchers.keys()];
    await Promise.all(jobs.map((jobId) => this.pollWatchedJob(jobId)));
  }

  stopJob(jobId: string): void {
    this.stopWatching(jobId);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.watchers.values()) this.dependencies.timers.clearInterval(timer);
    this.watchers.clear();
    this.jobsByWatcher.clear();
    this.pendingOwnership.clear();
  }

  private async pollWatchedJob(jobId: string): Promise<void> {
    const job = this.jobsByWatcher.get(jobId);
    if (!job) return;
    if (this.pendingOwnership.has(jobId)) {
      const ownership = await this.ownership(job);
      if (this.stopped || ownership === "retry") return;
      if (ownership === "foreign") {
        this.stopWatching(jobId);
        return;
      }
      this.pendingOwnership.delete(jobId);
    }
    await this.pollJob(job);
  }

  private readonly jobsByWatcher = new Map<string, DelegationJobRecord>();

  private async ownership(job: DelegationJobRecord): Promise<"owned" | "foreign" | "retry"> {
    const { identity } = this.dependencies;
    if (job.parentSessionId !== undefined) {
      return job.parentSessionId === identity.sessionId &&
        (job.parentSessionFile === undefined || job.parentSessionFile === identity.sessionFile)
        ? "owned"
        : "foreign";
    }

    if (job.parentSessionFile !== undefined) {
      return job.parentSessionFile !== null && job.parentSessionFile === identity.sessionFile
        ? "owned"
        : "foreign";
    }

    try {
      const legacyParent = await this.dependencies.readLegacyParentSessionFile(job);
      return legacyParent !== null && legacyParent === identity.sessionFile ? "owned" : "foreign";
    } catch (error) {
      this.report(job.jobId, "cannot verify legacy parent ownership; polling will retry", error);
      return "retry";
    }
  }

  private async pollJob(job: DelegationJobRecord): Promise<void> {
    if (this.stopped || this.importedJobs.has(job.jobId) || this.checkingJobs.has(job.jobId)) {
      return;
    }

    this.jobsByWatcher.set(job.jobId, job);
    this.checkingJobs.add(job.jobId);
    try {
      const delivered = this.deliveredRecords.get(job.jobId);
      if (delivered) {
        this.acceptImport(delivered);
        return;
      }

      const rawResult = (await this.dependencies.readResult(job))?.trim();
      if (this.stopped || !rawResult) return;

      const fullResultPath = resultPath(job.jobDir);
      const result = this.dependencies.truncateResult(rawResult, fullResultPath);
      const record: DelegationResultRecord = {
        jobId: job.jobId,
        jobDir: job.jobDir,
        importedAt: this.dependencies.now().toISOString(),
        resultPreview: result.slice(0, 1_000),
      };

      // Pi persists the custom follow-up when it accepts sendMessage. If appendImport
      // then fails, restore can use the follow-up details and retry only the import entry.
      this.dependencies.deliverFollowUp(record, buildParentFollowUp(job.jobId, result));
      this.deliveredRecords.set(job.jobId, record);
      this.acceptImport(record);
    } catch (error) {
      this.report(job.jobId, "result import failed; polling will retry", error);
    } finally {
      this.checkingJobs.delete(job.jobId);
    }
  }

  private acceptImport(record: DelegationResultRecord): void {
    this.dependencies.appendImport(record);
    this.importedJobs.add(record.jobId);
    this.stopWatching(record.jobId);
  }

  private stopWatching(jobId: string): void {
    const timer = this.watchers.get(jobId);
    if (timer !== undefined) this.dependencies.timers.clearInterval(timer);
    this.watchers.delete(jobId);
    this.jobsByWatcher.delete(jobId);
    this.pendingOwnership.delete(jobId);
  }

  private report(jobId: string, summary: string, error: unknown): void {
    const count = this.diagnosticCounts.get(jobId) ?? 0;
    if (count >= MAX_DIAGNOSTICS_PER_JOB) return;
    this.diagnosticCounts.set(jobId, count + 1);
    const detail = error instanceof Error ? error.message : String(error);
    this.dependencies.diagnostic(
      `Delegation Job ${jobId}: ${summary}: ${detail}`.slice(0, MAX_DIAGNOSTIC_LENGTH),
    );
  }
}

export function createParentMailboxCoordinator(
  pi: ExtensionAPI,
  identity: ParentSessionIdentity,
  options: {
    diagnostic(message: string): void;
    truncateResult(result: string, fullResultPath: string): string;
  },
): ParentMailboxCoordinator {
  return new ParentMailboxCoordinator({
    identity,
    appendImport: (record) => pi.appendEntry(SUB_CUSTOM_RESULT, record),
    deliverFollowUp: (record, content) =>
      pi.sendMessage(
        {
          customType: SUB_CUSTOM_RESULT,
          content,
          display: false,
          details: record,
        },
        { deliverAs: "followUp", triggerTurn: true },
      ),
    readResult: async (job) => {
      try {
        return await readTextFile(resultPath(job.jobDir));
      } catch (error) {
        if (isFileNotFound(error)) return undefined;
        throw error;
      }
    },
    readLegacyParentSessionFile: async (job) => (await readJobStatus(job.jobDir)).parentSessionFile,
    now: () => new Date(),
    timers: {
      setInterval: (handler, intervalMs) => setInterval(() => void handler(), intervalMs),
      clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
    },
    diagnostic: options.diagnostic,
    truncateResult: options.truncateResult,
  });
}

function parseDelegationJobRecord(value: unknown): DelegationJobRecord | undefined {
  if (
    !isObject(value) ||
    typeof value["jobId"] !== "string" ||
    typeof value["jobDir"] !== "string" ||
    typeof value["prompt"] !== "string" ||
    typeof value["cwd"] !== "string" ||
    typeof value["createdAt"] !== "string"
  ) {
    return undefined;
  }
  if (value["parentSessionId"] !== undefined && typeof value["parentSessionId"] !== "string") {
    return undefined;
  }
  if (
    value["parentSessionFile"] !== undefined &&
    value["parentSessionFile"] !== null &&
    typeof value["parentSessionFile"] !== "string"
  ) {
    return undefined;
  }
  return value as unknown as DelegationJobRecord;
}

function parseDelegationResultRecord(value: unknown): DelegationResultRecord | undefined {
  if (
    !isObject(value) ||
    typeof value["jobId"] !== "string" ||
    typeof value["jobDir"] !== "string" ||
    typeof value["importedAt"] !== "string" ||
    typeof value["resultPreview"] !== "string"
  ) {
    return undefined;
  }
  return value as unknown as DelegationResultRecord;
}

function isFileNotFound(error: unknown): boolean {
  return isObject(error) && error["code"] === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
