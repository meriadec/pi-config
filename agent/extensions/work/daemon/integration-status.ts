import { boundMessage, isValidBranchName } from "../shared/index.ts";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "./process-runner.ts";
import type { ProcessResult, ProcessRunner } from "./process-runner.ts";

const PROCESS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024;
/** Upper bound of cached SHA pairs; old entries leave first. */
const MAX_CACHE_ENTRIES = 500;
/** One extra calculation is enough for a Branch tip that moved while Git was read. */
const MAX_ATTEMPTS = 2;

/** Where one Topic Branch stands against the Branch that it must contain. */
export type IntegrationStatusKind = "current" | "behind" | "conflict" | "unknown";

export interface IntegrationStatus {
  kind: IntegrationStatusKind;
  /** Local Branch that the Topic must contain, absent when it cannot be resolved. */
  target?: string;
  /** Topic commits absent from the Integration Target. */
  ahead?: number;
  /** Integration Target commits absent from the Topic. */
  behind?: number;
  /** Bounded one-line explanation, always present for Unknown. */
  detail?: string;
}

export interface IntegrationStatusRequest {
  /** Repository checkout in which the bounded read-only Git commands run. */
  repositoryPath: string;
  /** Committed local Branch of the Topic. */
  branch: string;
  /** Committed local Branch that the Topic must contain. */
  targetBranch: string;
  signal?: AbortSignal;
}

export interface IntegrationStatusObserverOptions {
  runner?: ProcessRunner;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
  maxCacheEntries?: number;
}

/** The cached part of one observation: it depends on the SHA pair only, not on Branch names. */
type StatusCore = Pick<IntegrationStatus, "kind" | "ahead" | "behind" | "detail">;

/**
 * Observes local Integration Status from committed Branch tips only. It runs bounded,
 * argument-safe Git commands in the repository checkout, caches every result by the
 * resolved target and Topic SHA pair, and creates no timer, watcher, or temporary
 * Worktree. It never fetches, merges, rebases, resets, or moves a Branch.
 */
export class IntegrationStatusObserver {
  private readonly runner: ProcessRunner;
  private readonly processTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, StatusCore>();

  constructor(options: IntegrationStatusObserverOptions = {}) {
    this.runner = options.runner ?? new LocalProcessRunner();
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxCacheEntries = options.maxCacheEntries ?? MAX_CACHE_ENTRIES;
  }

  /** Observes one Integration Chain edge. Every unusable input or Git result is Unknown. */
  async observe(request: IntegrationStatusRequest): Promise<IntegrationStatus> {
    const target = request.targetBranch;
    if (!isValidBranchName(request.branch) || !isValidBranchName(target)) {
      return unknownIntegrationStatus("A Branch name of this Integration Chain edge is not valid.");
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const topicSha = await this.resolveTip(request, request.branch);
      const targetSha = await this.resolveTip(request, target);
      if (topicSha === undefined || targetSha === undefined) {
        return {
          ...unknownIntegrationStatus("A local Branch of this Integration Chain edge is missing."),
          target,
        };
      }
      const key = cacheKey(targetSha, topicSha);
      const cached = this.cache.get(key);
      if (cached !== undefined) return { ...cached, target };
      const core = await this.calculate(request, targetSha, topicSha);
      // A tip that moved during the calculation makes the result stale before it is published.
      const movedTopic = await this.resolveTip(request, request.branch);
      const movedTarget = await this.resolveTip(request, target);
      if (movedTopic !== topicSha || movedTarget !== targetSha) continue;
      this.remember(key, core);
      return { ...core, target };
    }
    return {
      ...unknownIntegrationStatus("Branch tips moved while Integration Status was calculated."),
      target,
    };
  }

  /** Number of cached SHA pairs. Diagnostic surface for bounded-cache behaviour. */
  get cacheSize(): number {
    return this.cache.size;
  }

  private async calculate(
    request: IntegrationStatusRequest,
    targetSha: string,
    topicSha: string,
  ): Promise<StatusCore> {
    if (targetSha === topicSha) return { kind: "current", ahead: 0, behind: 0 };

    const counts = await this.counts(request, targetSha, topicSha);
    if (counts === undefined) {
      return unknownIntegrationStatus(
        "Git could not count the commits of this Integration Chain edge.",
      );
    }
    if (counts.behind === 0) return { kind: "current", ahead: counts.ahead, behind: 0 };

    const related = await this.git(request, ["merge-base", targetSha, topicSha]);
    if (related?.exitCode !== 0) {
      return {
        ...unknownIntegrationStatus(
          "The Topic and its Integration Target have unrelated histories.",
        ),
        ...counts,
      };
    }
    const merge = await this.git(
      request,
      ["merge-tree", "--write-tree", topicSha, targetSha],
      true,
    );
    if (merge === undefined || merge.exitCode === null || merge.exitCode > 1) {
      return {
        ...unknownIntegrationStatus(
          "Git could not predict the merge of this Integration Chain edge.",
        ),
        ...counts,
      };
    }
    return { kind: merge.exitCode === 1 ? "conflict" : "behind", ...counts };
  }

  /** Commits of each side of the symmetric difference, as `behind` and `ahead`. */
  private async counts(
    request: IntegrationStatusRequest,
    targetSha: string,
    topicSha: string,
  ): Promise<{ ahead: number; behind: number } | undefined> {
    const result = await this.git(request, [
      "rev-list",
      "--left-right",
      "--count",
      `${targetSha}...${topicSha}`,
    ]);
    if (result === undefined || result.exitCode !== 0) return undefined;
    const [behind, ahead] = result.stdout.trim().split(/\s+/, 2).map(Number);
    if (behind === undefined || ahead === undefined) return undefined;
    if (!Number.isInteger(behind) || !Number.isInteger(ahead)) return undefined;
    return { ahead, behind };
  }

  /** The committed local tip of one Branch. Remote refs never take part in the answer. */
  private async resolveTip(
    request: IntegrationStatusRequest,
    branch: string,
  ): Promise<string | undefined> {
    const result = await this.git(request, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ]);
    if (result === undefined || result.exitCode !== 0) return undefined;
    const line = result.stdout.split("\n", 1)[0]?.trim() ?? "";
    return /^[0-9a-f]{40}$/.test(line) ? line : undefined;
  }

  /**
   * Runs one bounded read-only Git command in a clean repository-local environment.
   * An unusable result becomes undefined; `allowTruncatedOutput` keeps a result whose
   * exit code alone carries the answer.
   */
  private async git(
    request: IntegrationStatusRequest,
    args: readonly string[],
    allowTruncatedOutput = false,
  ): Promise<ProcessResult | undefined> {
    const result = await this.runner
      .run({
        command: "git",
        args,
        cwd: request.repositoryPath,
        timeoutMs: this.processTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      .catch(() => undefined);
    if (result === undefined || result.status !== "completed") return undefined;
    if (result.outputTruncated && !allowTruncatedOutput) return undefined;
    return result;
  }

  private remember(key: string, core: StatusCore): void {
    if (core.kind === "unknown") return;
    this.cache.delete(key);
    this.cache.set(key, core);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }
}

/** An Unknown status always carries a bounded reason. */
export function unknownIntegrationStatus(detail: string): IntegrationStatus {
  return { kind: "unknown", detail: boundMessage(detail) };
}

function cacheKey(targetSha: string, topicSha: string): string {
  return `${targetSha}:${topicSha}`;
}
