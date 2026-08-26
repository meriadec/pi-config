import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "../daemon/process-runner.ts";
import type { ProcessResult, ProcessRunner } from "../daemon/process-runner.ts";
import {
  WorkDataError,
  boundMessage,
  isValidBranchName,
  parseRepository,
} from "../shared/domain.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT_BYTES = 16 * 1024;
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

export interface TopicCreationInput {
  name: string;
  repository?: string;
  branch?: string;
  startPoint?: string;
  sourceCheckout?: string;
}

export interface ResolvedTopicStartPoint {
  commit: string;
  sourceCheckout: string;
}

/** Explicit client input that is safe to send to the Topic creation boundary. */
export interface ResolvedTopicCreationInput {
  name: string;
  repository: string;
  branch: string;
  startPoint?: ResolvedTopicStartPoint;
}

export interface TopicCreationResolverOptions {
  runner?: ProcessRunner;
}

/** Resolve optional local Git input without changing the checkout or contacting the daemon. */
export async function resolveTopicCreationInput(
  input: TopicCreationInput,
  options: TopicCreationResolverOptions = {},
): Promise<ResolvedTopicCreationInput> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new WorkDataError("invalid-topic-name", "Topic name must not be empty.");
  }

  const branch = input.branch?.trim() ?? defaultBranchForTopicName(name);
  if (!isValidBranchName(branch)) {
    const message =
      input.branch === undefined
        ? "Topic name cannot make a safe branch."
        : "Branch must be a valid non-empty Git branch name.";
    throw new WorkDataError("invalid-branch", message);
  }

  const explicitRepository = input.repository?.trim();
  if (explicitRepository !== undefined) parseRepository(explicitRepository);
  const revision = input.startPoint?.trim();
  if (input.startPoint !== undefined && revision?.length === 0) {
    throw new WorkDataError("invalid-start-point", "Start Point must not be empty.");
  }

  if (explicitRepository !== undefined && revision === undefined) {
    return { name, repository: explicitRepository, branch };
  }
  if (input.sourceCheckout === undefined) {
    throw new WorkDataError(
      "source-checkout-required",
      "Source checkout is required to infer a repository or resolve a Start Point.",
    );
  }

  const runner = options.runner ?? new LocalProcessRunner();
  const sourceCheckout = await worktreeRoot(input.sourceCheckout, runner);
  const inferredRepository = await originRepository(sourceCheckout, runner);
  const repository = explicitRepository ?? inferredRepository;
  if (revision !== undefined && repository.toLowerCase() !== inferredRepository.toLowerCase()) {
    throw new WorkDataError(
      "repository-mismatch",
      `Source checkout origin ${inferredRepository} does not match repository ${repository}.`,
    );
  }

  const resolved: ResolvedTopicCreationInput = { name, repository, branch };
  if (revision !== undefined) {
    resolved.startPoint = {
      commit: await resolveCommit(revision, sourceCheckout, runner),
      sourceCheckout,
    };
  }
  return resolved;
}

/** Parse the common HTTPS and SSH GitHub remote forms to owner/repo. */
export function parseGitHubOrigin(remote: string): string {
  const value = remote.trim();
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)\/?$/.exec(
      value,
    );
  const owner = match?.[1];
  const repository = match?.[2]?.replace(/\.git$/, "");
  if (owner === undefined || repository === undefined) {
    throw new WorkDataError(
      "invalid-origin",
      "Source checkout origin must be an HTTPS or SSH GitHub repository URL.",
    );
  }
  return parseRepository(`${owner}/${repository}`).fullName;
}

async function worktreeRoot(path: string, runner: ProcessRunner): Promise<string> {
  let cwd: string;
  try {
    cwd = await realpath(resolve(path));
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new WorkDataError(
      "invalid-source-checkout",
      "Source checkout must be an existing directory.",
    );
  }
  const result = await git(runner, cwd, ["rev-parse", "--show-toplevel"]);
  if (!succeeded(result)) {
    throw gitError("Source checkout is not inside a Git worktree", result);
  }
  const root = result.stdout.trim();
  try {
    return await realpath(root);
  } catch {
    throw new WorkDataError(
      "invalid-source-checkout",
      "Git returned an invalid Source checkout root.",
    );
  }
}

async function originRepository(root: string, runner: ProcessRunner): Promise<string> {
  const result = await git(runner, root, ["remote", "get-url", "origin"]);
  if (!succeeded(result)) throw gitError("Cannot read Source checkout origin", result);
  return parseGitHubOrigin(result.stdout);
}

async function resolveCommit(
  revision: string,
  root: string,
  runner: ProcessRunner,
): Promise<string> {
  const result = await git(runner, root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
  const commit = result.stdout.trim();
  if (!succeeded(result) || result.stderr.trim().length > 0 || !FULL_COMMIT_SHA.test(commit)) {
    throw gitError(`Start Point ${revision} does not resolve to one commit`, result);
  }
  return commit.toLowerCase();
}

async function git(
  runner: ProcessRunner,
  cwd: string,
  args: readonly string[],
): Promise<ProcessResult> {
  try {
    return await runner.run({
      command: "git",
      args,
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
      unsetEnv: GIT_LOCAL_ENVIRONMENT_VARIABLES,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Unknown process error.";
    throw new WorkDataError("git-resolution-failed", boundMessage(`Cannot run Git: ${detail}`));
  }
}

function succeeded(result: ProcessResult): boolean {
  return result.status === "completed" && result.exitCode === 0 && !result.outputTruncated;
}

function gitError(subject: string, result: ProcessResult): WorkDataError {
  let detail = result.stderr.trim() || result.stdout.trim();
  if (result.status === "timeout") detail = "Git command timed out.";
  if (result.status === "cancelled") detail = "Git command was cancelled.";
  if (result.outputTruncated) detail = "Git output exceeded the allowed size.";
  return new WorkDataError(
    "git-resolution-failed",
    boundMessage(detail.length === 0 ? `${subject}.` : `${subject}: ${detail}`),
  );
}
