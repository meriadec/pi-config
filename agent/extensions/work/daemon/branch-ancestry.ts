import { isValidBranchName } from "../shared/index.ts";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "./process-runner.ts";
import type { ProcessRunner } from "./process-runner.ts";

const PROCESS_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 8 * 1024;

/** One end of an ancestry question: a committed local Branch tip or an exact commit. */
export type AncestryRef = { branch: string } | { commit: string };

export interface AncestryRequest {
  /** Repository checkout in which the bounded read-only Git command runs. */
  repositoryPath: string;
  ancestor: AncestryRef;
  descendant: AncestryRef;
  signal?: AbortSignal;
}

export interface BranchAncestryReaderOptions {
  runner?: ProcessRunner;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Answers committed Git ancestry questions for Integration Chain placement. It runs one
 * bounded, argument-safe `git merge-base --is-ancestor` per question in a repository
 * checkout, and never fetches, merges, rebases, resets, or moves a Branch. An answer that
 * Git cannot give reliably is undefined, which callers treat as ambiguous.
 */
export class BranchAncestryReader {
  private readonly runner: ProcessRunner;
  private readonly processTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: BranchAncestryReaderOptions = {}) {
    this.runner = options.runner ?? new LocalProcessRunner();
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  /** True when the `descendant` tip contains the `ancestor` tip, undefined when unknown. */
  async contains(request: AncestryRequest): Promise<boolean | undefined> {
    const ancestor = revision(request.ancestor);
    const descendant = revision(request.descendant);
    if (ancestor === undefined || descendant === undefined) return undefined;
    const result = await this.runner
      .run({
        command: "git",
        args: ["merge-base", "--is-ancestor", ancestor, descendant],
        cwd: request.repositoryPath,
        timeoutMs: this.processTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      .catch(() => undefined);
    if (result === undefined || result.status !== "completed") return undefined;
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    return undefined;
  }
}

/** The argument-safe revision of one ancestry end; an unusable reference has none. */
function revision(reference: AncestryRef): string | undefined {
  if ("commit" in reference) {
    return /^[0-9a-f]{40}$/i.test(reference.commit) ? reference.commit : undefined;
  }
  return isValidBranchName(reference.branch)
    ? `refs/heads/${reference.branch}^{commit}`
    : undefined;
}
