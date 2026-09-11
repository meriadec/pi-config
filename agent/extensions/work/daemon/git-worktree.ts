import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { agentGitConfigGlobal } from "../../lib/agent-git-config.ts";
import { boundMessage } from "../shared/domain.ts";
import {
  GIT_LOCAL_ENVIRONMENT_VARIABLES,
  LocalProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "./process-runner.ts";

const INSPECTION_TIMEOUT_MS = 10_000;
const REBASE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024;

export type GitOperationKind = "rebase" | "merge" | "cherry-pick" | "revert";

/** A Git operation that currently owns one Topic Worktree. */
export interface GitOperationState {
  kind: GitOperationKind;
  conflict: boolean;
}

/** Last observed local state needed to decide whether a Topic Branch can be rebased. */
export interface GitWorktreeState {
  clean?: boolean;
  checkedOutBranch?: string;
  operation?: GitOperationState;
}

export interface GitRebaseResult {
  status: "rebased" | "failed" | "timeout" | "cancelled";
  reason?: string;
}

export interface GitWorktreeController {
  inspect(worktreePath: string): Promise<GitWorktreeState>;
  inspectOperation(worktreePath: string): Promise<GitOperationState | undefined>;
  rebase(worktreePath: string, targetBranch: string): Promise<GitRebaseResult>;
}

export interface LocalGitWorktreeControllerOptions {
  runner?: ProcessRunner;
  stat?: typeof stat;
  inspectionTimeoutMs?: number;
  rebaseTimeoutMs?: number;
  maxOutputBytes?: number;
}

/** Inspects and explicitly rebases Topic Worktrees without reading remote state. */
export class LocalGitWorktreeController implements GitWorktreeController {
  private readonly runner: ProcessRunner;
  private readonly fileStat: typeof stat;
  private readonly inspectionTimeoutMs: number;
  private readonly rebaseTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: LocalGitWorktreeControllerOptions = {}) {
    this.runner = options.runner ?? new LocalProcessRunner();
    this.fileStat = options.stat ?? stat;
    this.inspectionTimeoutMs = options.inspectionTimeoutMs ?? INSPECTION_TIMEOUT_MS;
    this.rebaseTimeoutMs = options.rebaseTimeoutMs ?? REBASE_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  }

  /** Reads full rebase eligibility state. Ignored files do not make the Worktree dirty. */
  async inspect(worktreePath: string): Promise<GitWorktreeState> {
    const [operation, branch, status] = await Promise.all([
      this.inspectOperation(worktreePath),
      this.git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      this.git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"]),
    ]);
    const checkedOutBranch = branch?.stdout.split("\n", 1)[0]?.trim();
    return {
      ...(branch?.exitCode === 0 && checkedOutBranch ? { checkedOutBranch } : {}),
      ...(status?.exitCode === 0 ? { clean: status.stdout.length === 0 } : {}),
      ...(operation === undefined ? {} : { operation }),
    };
  }

  /** Reads only inexpensive Git metadata used by the 30-second local health poll. */
  async inspectOperation(worktreePath: string): Promise<GitOperationState | undefined> {
    const directory = await this.git(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    if (directory?.exitCode !== 0) return undefined;
    const gitDirectory = directory.stdout.split("\n", 1)[0]?.trim() ?? "";
    if (!isAbsolute(gitDirectory)) return undefined;
    const kind = await this.operationKind(gitDirectory);
    if (kind === undefined) return undefined;
    const unmerged = await this.git(worktreePath, ["ls-files", "--unmerged"]);
    return { kind, conflict: unmerged?.exitCode === 0 && unmerged.stdout.length > 0 };
  }

  /** Runs the one explicit local Branch mutation. It never aborts or continues a failure. */
  async rebase(worktreePath: string, targetBranch: string): Promise<GitRebaseResult> {
    let result: ProcessResult;
    try {
      result = await this.runner.run({
        command: "git",
        args: ["rebase", targetBranch],
        cwd: worktreePath,
        timeoutMs: this.rebaseTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
        env: {
          GIT_CONFIG_GLOBAL: agentGitConfigGlobal(),
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
        },
      });
    } catch (error) {
      return { status: "failed", reason: errorMessage(error) };
    }
    if (result.status !== "completed") return { status: result.status };
    if (result.exitCode === 0) return { status: "rebased" };
    const output = result.stderr.trim() || result.stdout.trim() || "Git rebase failed.";
    return { status: "failed", reason: boundMessage(output) };
  }

  private async operationKind(gitDirectory: string): Promise<GitOperationKind | undefined> {
    const candidates: readonly [GitOperationKind, string][] = [
      ["rebase", "rebase-merge"],
      ["rebase", "rebase-apply"],
      ["merge", "MERGE_HEAD"],
      ["cherry-pick", "CHERRY_PICK_HEAD"],
      ["revert", "REVERT_HEAD"],
    ];
    for (const [kind, marker] of candidates) {
      if (await exists(resolve(gitDirectory, marker), this.fileStat)) return kind;
    }
    return undefined;
  }

  private async git(
    worktreePath: string,
    args: readonly string[],
  ): Promise<ProcessResult | undefined> {
    try {
      const result = await this.runner.run({
        command: "git",
        args,
        cwd: worktreePath,
        timeoutMs: this.inspectionTimeoutMs,
        maxOutputBytes: this.maxOutputBytes,
        unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
      });
      if (result.status !== "completed" || result.outputTruncated) return undefined;
      return result;
    } catch {
      return undefined;
    }
  }
}

async function exists(path: string, fileStat: typeof stat): Promise<boolean> {
  try {
    await fileStat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return boundMessage(error instanceof Error ? error.message : "Git rebase failed.");
}
