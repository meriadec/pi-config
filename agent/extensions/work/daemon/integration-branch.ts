import {
  isValidBranchName,
  resolveBaseCheckout,
  resolveIntegrationBranch,
} from "../shared/index.ts";
import type { ConfigStore, WorkConfig } from "../shared/index.ts";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "./process-runner.ts";
import type { ProcessResult, ProcessRunner } from "./process-runner.ts";

const PROCESS_TIMEOUT_MS = 10_000;
const MAX_PROCESS_OUTPUT_BYTES = 8 * 1024;
const FALLBACK_BRANCHES = ["main", "master"] as const;

export interface IntegrationBranchResolverOptions {
  config: ConfigStore;
  runner?: ProcessRunner;
  processTimeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Owns the repository Integration Branch: it reads local Git refs only, infers a missing
 * Integration Branch exactly once, and persists it in the repository configuration entry.
 * It never fetches, merges, rebases, resets, or moves a Branch.
 */
export class IntegrationBranchResolver {
  private readonly config: ConfigStore;
  private readonly runner: ProcessRunner;
  private readonly processTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: IntegrationBranchResolverOptions) {
    this.config = options.config;
    this.runner = options.runner ?? new LocalProcessRunner();
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  }

  /**
   * Returns the persisted Integration Branch of one repository, inferring and storing it
   * when the configuration has none yet. Returns undefined when no local candidate exists.
   */
  ensure(repository: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.serialize(async () => {
      const config = await this.config.load();
      if (config === null) return undefined;
      const stored = resolveIntegrationBranch(config, repository);
      if (stored !== undefined) return stored;
      const baseCheckout = resolveBaseCheckout(config, repository);
      if (baseCheckout === undefined) return undefined;
      const inferred = await this.infer(baseCheckout, signal);
      if (inferred === undefined) return undefined;
      // Re-check under the same serialized turn so an existing value is never replaced.
      const saved = await this.config.update((current) =>
        resolveIntegrationBranch(current, repository) === undefined
          ? withIntegrationBranch(current, repository, inferred)
          : current,
      );
      return resolveIntegrationBranch(saved, repository);
    });
  }

  /** Ensures each repository once, ignoring repositories whose Git state gives no candidate. */
  async ensureAll(repositories: Iterable<string>, signal?: AbortSignal): Promise<void> {
    for (const repository of new Set(repositories)) {
      await this.ensure(repository, signal).catch(() => undefined);
    }
  }

  private async infer(baseCheckout: string, signal?: AbortSignal): Promise<string | undefined> {
    const head = await this.gitLine(
      baseCheckout,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    );
    if (head !== undefined && isValidBranchName(head)) return head;

    const originHead = await this.gitLine(
      baseCheckout,
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      signal,
    );
    const candidate = originHead?.startsWith("origin/") === true ? originHead.slice(7) : undefined;
    if (
      candidate !== undefined &&
      isValidBranchName(candidate) &&
      (await this.localBranchExists(baseCheckout, candidate, signal))
    ) {
      return candidate;
    }

    for (const branch of FALLBACK_BRANCHES) {
      if (await this.localBranchExists(baseCheckout, branch, signal)) return branch;
    }
    return undefined;
  }

  private async localBranchExists(
    baseCheckout: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.git(
      baseCheckout,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      signal,
    );
    return result?.exitCode === 0;
  }

  private async gitLine(
    baseCheckout: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.git(baseCheckout, args, signal);
    if (result === undefined || result.exitCode !== 0) return undefined;
    const line = result.stdout.split("\n", 1)[0]?.trim() ?? "";
    return line.length === 0 ? undefined : line;
  }

  /** Runs one bounded read-only Git command; an unusable result becomes undefined. */
  private async git(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProcessResult | undefined> {
    const result = await this.runner
      .run({
        command: "git",
        args,
        cwd,
        timeoutMs: this.processTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
        ...(signal === undefined ? {} : { signal }),
      })
      .catch(() => undefined);
    if (result === undefined || result.status !== "completed" || result.outputTruncated) {
      return undefined;
    }
    return result;
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.catch(() => undefined);
    const current = previous.then(operation);
    this.pending = current.catch(() => undefined);
    return current;
  }
}

function withIntegrationBranch(
  config: WorkConfig,
  repository: string,
  integrationBranch: string,
): WorkConfig {
  const recipe = config.repositories[repository] ?? { setupCommands: [] };
  return {
    ...config,
    repositories: {
      ...config.repositories,
      [repository]: { ...recipe, integrationBranch },
    },
  };
}
