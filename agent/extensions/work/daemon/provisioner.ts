import { realpath, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  WorkDataError,
  boundMessage,
  parseRepository,
  resolveActionPolicy,
} from "../shared/index.ts";
import type {
  ActionId,
  ResolvedPolicy,
  TopicManifest,
  TopicSetup,
  TopicStore,
  WorkPolicies,
} from "../shared/index.ts";
import { LocalProcessRunner } from "./process-runner.ts";
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  ProcessStatus,
} from "./process-runner.ts";

const PROCESS_TIMEOUT_MS = 30_000;
const SETUP_COMMAND_TIMEOUT_MS = 300_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_WT_JSON_BYTES = 64 * 1024;

/** Live progress of one Setup command as the Repository Recipe runs. */
export interface SetupProgress {
  index: number;
  total: number;
  command: string;
}

export interface ProvisionRequest {
  topicId: string;
  workBase: string;
  /**
   * Resolved Base checkout location for this Topic's repository. When omitted, it
   * defaults to `WORK_BASE/<repo-name>`; a per-repository `basePath` override sets it
   * to a checkout outside `WORK_BASE`.
   */
  baseCheckout?: string;
  policies: WorkPolicies;
  /** The repository's Repository Recipe, run only when a fresh Worktree is created. */
  recipe?: readonly string[];
  approvedActions?: ReadonlySet<ActionId>;
  onSetupProgress?: (progress: SetupProgress) => void;
  signal?: AbortSignal;
}

export type ProvisionResult =
  | { status: "ready"; topic: TopicManifest }
  | {
      status: "confirmation-required";
      action: "repository.clone" | "topic.create-worktree" | "topic.run-setup";
      policy: ResolvedPolicy;
      topic: TopicManifest;
    }
  | { status: "denied"; action: ActionId; reason: string; topic: TopicManifest }
  | { status: "failed" | "timeout" | "cancelled"; reason: string; topic: TopicManifest };

export interface TopicProvisionerOptions {
  topics: TopicStore;
  runner?: ProcessRunner;
  ghCommand?: string;
  setupShell?: string;
  processTimeoutMs?: number;
  setupCommandTimeoutMs?: number;
  maxProcessOutputBytes?: number;
}

/** Provision a Base checkout and Topic worktree without owning wt path conventions. */
export class TopicProvisioner {
  private readonly topics: TopicStore;
  private readonly runner: ProcessRunner;
  private readonly ghCommand: string;
  private readonly setupShell: string;
  private readonly processTimeoutMs: number;
  private readonly setupCommandTimeoutMs: number;
  private readonly maxProcessOutputBytes: number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: TopicProvisionerOptions) {
    this.topics = options.topics;
    this.runner = options.runner ?? new LocalProcessRunner();
    this.ghCommand = options.ghCommand ?? "gh";
    this.setupShell = options.setupShell ?? defaultLoginShell();
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
    this.setupCommandTimeoutMs = options.setupCommandTimeoutMs ?? SETUP_COMMAND_TIMEOUT_MS;
    this.maxProcessOutputBytes = options.maxProcessOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  }

  provision(request: ProvisionRequest): Promise<ProvisionResult> {
    return this.serialize(request.topicId, () => this.provisionSerial(request));
  }

  private async provisionSerial(request: ProvisionRequest): Promise<ProvisionResult> {
    let topic = await this.topics.update(request.topicId, (current) => ({
      ...current,
      setup: withoutReason(current.setup, "provisioning"),
    }));
    // Whether a prior run already passed the Worktree checkpoint. This decides,
    // exactly once, whether the Repository Recipe applies to this Worktree.
    const worktreeWasCreated = topic.setup.worktreeCreated;

    try {
      this.assertNotCancelled(request.signal);
      await assertDirectory(
        request.workBase,
        "Configured workBase does not exist or is not a directory.",
      );
      const repository = parseRepository(topic.repository);
      const baseCheckout = request.baseCheckout ?? join(request.workBase, repository.name);

      if (await pathExists(baseCheckout)) {
        await this.validateBaseCheckout(baseCheckout, repository.fullName, request.signal);
      } else {
        const policyResult = await this.enforcePolicy("repository.clone", topic, request);
        if (policyResult !== undefined) return policyResult;

        const clone = await this.run({
          command: this.ghCommand,
          args: ["repo", "clone", repository.fullName, baseCheckout],
          cwd: request.workBase,
          signal: request.signal,
        });
        if (clone.status !== "completed") throw controlError(clone.status, "Repository clone");
        if (clone.exitCode !== 0) {
          // A clone can finish before its caller receives the result. Reconcile the filesystem first.
          if (!(await pathExists(baseCheckout))) {
            throw failure(
              "repository-clone-failed",
              processFailure("Repository clone failed", clone),
            );
          }
        }
        await this.validateBaseCheckout(baseCheckout, repository.fullName, request.signal);
      }

      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: { ...current.setup, repositoryAvailable: true },
      }));

      let worktreePath = await this.findTopicWorktree(baseCheckout, topic.branch, request.signal);
      let createdThisRun = false;
      if (worktreePath === undefined) {
        createdThisRun = true;
        const branchExists = await this.branchExists(baseCheckout, topic.branch, request.signal);
        const policyResult = await this.enforcePolicy("topic.create-worktree", topic, request);
        if (policyResult !== undefined) return policyResult;

        const args = branchExists
          ? ["switch", topic.branch, "--format", "json"]
          : ["switch", "--create", topic.branch, "--format", "json"];
        const switched = await this.run({
          command: "wt",
          args,
          cwd: baseCheckout,
          signal: request.signal,
        });
        if (switched.status !== "completed") {
          if (switched.status === "cancelled") throw controlError("cancelled", "Worktree creation");
          worktreePath = await this.findTopicWorktree(baseCheckout, topic.branch, request.signal);
          if (worktreePath === undefined) throw controlError("timeout", "Worktree creation");
        } else if (switched.exitCode === 0 && !switched.outputTruncated) {
          worktreePath = parseWtPath(switched.stdout);
        }

        if (worktreePath === undefined) {
          worktreePath = await this.findTopicWorktree(baseCheckout, topic.branch, request.signal);
        }
        if (worktreePath === undefined) {
          if (switched.outputTruncated || Buffer.byteLength(switched.stdout) > MAX_WT_JSON_BYTES) {
            throw failure("invalid-wt-output", "wt returned oversized JSON output.");
          }
          if (switched.exitCode !== 0) {
            throw failure("wt-failed", processFailure("wt failed", switched));
          }
          throw failure(
            "invalid-wt-output",
            "wt did not return a supported absolute worktree path.",
          );
        }
      }

      await this.validateTopicWorktree(
        baseCheckout,
        worktreePath,
        topic.branch,
        repository.fullName,
        request.signal,
      );
      // Decide the Recipe outcome once, on the first pass reaching this checkpoint.
      // A Worktree that already existed here (not created by us) skips the Recipe
      // for good; a Worktree we create runs it (and retries re-run it until success).
      const setupCommandsRun = worktreeWasCreated ? topic.setup.setupCommandsRun : !createdThisRun;
      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: {
          ...current.setup,
          repositoryAvailable: true,
          worktreeCreated: true,
          setupCommandsRun: worktreeWasCreated ? current.setup.setupCommandsRun : setupCommandsRun,
        },
        worktreePath,
      }));
      // Validate the durable value, not only the process response, before ready is persisted.
      await this.validateTopicWorktree(
        baseCheckout,
        topic.worktreePath!,
        topic.branch,
        repository.fullName,
        request.signal,
      );
      if (!topic.setup.setupCommandsRun) {
        const recipeResult = await this.runRecipe(topic, topic.worktreePath!, request);
        if (recipeResult !== undefined) return recipeResult;
        topic = await this.topics.update(topic.id, (current) => ({
          ...current,
          setup: { ...current.setup, setupCommandsRun: true },
        }));
      }
      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: withoutReason(current.setup, "ready"),
      }));
      return { status: "ready", topic };
    } catch (error) {
      const terminal = asProvisionError(error);
      topic = await this.topics.update(topic.id, (current) => ({
        ...current,
        setup: { ...current.setup, state: "setup-failed", reason: terminal.message },
      }));
      return { status: terminal.status, reason: terminal.message, topic };
    }
  }

  /**
   * Run the Repository Recipe line by line in the fresh Worktree. Returns a
   * ProvisionResult only when a policy blocks the run; otherwise resolves once
   * every Setup command succeeded, or throws to fail the whole provision.
   */
  private async runRecipe(
    topic: TopicManifest,
    worktreePath: string,
    request: ProvisionRequest,
  ): Promise<ProvisionResult | undefined> {
    const recipe = request.recipe ?? [];
    if (recipe.length === 0) return undefined;
    const policyResult = await this.enforcePolicy("topic.run-setup", topic, request);
    if (policyResult !== undefined) return policyResult;
    for (let index = 0; index < recipe.length; index += 1) {
      const command = recipe[index]!;
      this.assertNotCancelled(request.signal);
      request.onSetupProgress?.({ index, total: recipe.length, command });
      const result = await this.run({
        command: this.setupShell,
        args: ["-lc", command],
        cwd: worktreePath,
        timeoutMs: this.setupCommandTimeoutMs,
        signal: request.signal,
      });
      if (result.status !== "completed") throw controlError(result.status, "Setup command");
      if (result.exitCode !== 0) {
        throw failure(
          "setup-command-failed",
          processFailure(`Setup command failed: ${command}`, result),
        );
      }
    }
    return undefined;
  }

  private async enforcePolicy(
    action: "repository.clone" | "topic.create-worktree" | "topic.run-setup",
    topic: TopicManifest,
    request: ProvisionRequest,
  ): Promise<ProvisionResult | undefined> {
    const policy = resolveActionPolicy(request.policies, action, {
      topicId: topic.id,
      repository: topic.repository,
    });
    if (
      policy.policy === "allow" ||
      (policy.policy === "ask" && request.approvedActions?.has(action) === true)
    ) {
      return undefined;
    }
    if (policy.policy === "ask") {
      return { status: "confirmation-required", action, policy, topic };
    }
    const reason = boundMessage(`Policy denied ${action}.`);
    const failed = await this.topics.update(topic.id, (current) => ({
      ...current,
      setup: { ...current.setup, state: "setup-failed", reason },
    }));
    return { status: "denied", action, reason, topic: failed };
  }

  private async validateBaseCheckout(
    path: string,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const pathStat = await stat(path).catch(() => undefined);
    if (pathStat?.isDirectory() !== true) {
      throw failure("repository-conflict", "Base checkout path exists but is not a directory.");
    }
    const root = await this.git(path, ["rev-parse", "--show-toplevel"], signal);
    if (root.exitCode !== 0) {
      throw failure("repository-conflict", "Base checkout path is not a Git repository.");
    }
    const expectedRoot = await realpath(path);
    const actualRoot = await realpath(resolve(path, root.stdout.trim())).catch(() => "");
    if (actualRoot !== expectedRoot) {
      throw failure("repository-conflict", "Base checkout path is not a Git repository root.");
    }
    const origin = await this.git(path, ["remote", "get-url", "origin"], signal);
    if (
      origin.exitCode !== 0 ||
      normalizeGitHubRemote(origin.stdout) !== expectedRepository.toLowerCase()
    ) {
      throw failure("repository-conflict", "Base checkout origin belongs to another repository.");
    }
  }

  private async validateTopicWorktree(
    baseCheckout: string,
    worktreePath: string,
    expectedBranch: string,
    expectedRepository: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!isAbsolute(worktreePath)) {
      throw failure("invalid-worktree", "wt returned a relative worktree path.");
    }
    await assertDirectory(worktreePath, "wt returned a missing worktree path.");
    const [baseCommon, worktreeCommon, root, origin, branch] = await Promise.all([
      this.git(baseCheckout, ["rev-parse", "--git-common-dir"], signal),
      this.git(worktreePath, ["rev-parse", "--git-common-dir"], signal),
      this.git(worktreePath, ["rev-parse", "--show-toplevel"], signal),
      this.git(worktreePath, ["remote", "get-url", "origin"], signal),
      this.git(worktreePath, ["symbolic-ref", "--short", "HEAD"], signal),
    ]);
    if (
      [baseCommon, worktreeCommon, root, origin, branch].some((result) => result.exitCode !== 0)
    ) {
      throw failure("invalid-worktree", "wt path is not a valid Git worktree.");
    }
    const actualRoot = await realpath(resolve(worktreePath, root.stdout.trim())).catch(() => "");
    const expectedRoot = await realpath(worktreePath);
    const baseGit = await realpath(resolve(baseCheckout, baseCommon.stdout.trim())).catch(() => "");
    const worktreeGit = await realpath(resolve(worktreePath, worktreeCommon.stdout.trim())).catch(
      () => "",
    );
    if (
      actualRoot !== expectedRoot ||
      baseGit.length === 0 ||
      baseGit !== worktreeGit ||
      branch.stdout.trim() !== expectedBranch ||
      normalizeGitHubRemote(origin.stdout) !== expectedRepository.toLowerCase()
    ) {
      throw failure("invalid-worktree", "wt path is for a different Git repository.");
    }
  }

  private async findTopicWorktree(
    baseCheckout: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.git(baseCheckout, ["worktree", "list", "--porcelain", "-z"], signal);
    if (result.exitCode !== 0)
      throw failure("git-inspection-failed", "Cannot inspect Git worktrees.");
    const paths = parseWorktreeList(result.stdout, branch);
    if (paths.length > 1) {
      throw failure("worktree-conflict", "More than one worktree uses the topic branch.");
    }
    return paths[0];
  }

  private async branchExists(
    baseCheckout: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const result = await this.git(
      baseCheckout,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      signal,
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw failure("git-inspection-failed", "Cannot inspect the topic branch.");
  }

  private async git(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<ProcessResult> {
    const result = await this.run({ command: "git", args, cwd, signal });
    if (result.status !== "completed") throw controlError(result.status, "Git inspection");
    if (result.outputTruncated)
      throw failure("git-output-too-large", "Git inspection output was too large.");
    return result;
  }

  private run(request: {
    command: string;
    args: readonly string[];
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal | undefined;
  }): Promise<ProcessResult> {
    const bounded: ProcessRequest = {
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      timeoutMs: request.timeoutMs ?? this.processTimeoutMs,
      maxOutputBytes: this.maxProcessOutputBytes,
    };
    if (request.signal !== undefined) bounded.signal = request.signal;
    return this.runner.run(bounded);
  }

  private assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw controlError("cancelled", "Provisioning");
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    this.queues.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
}

export function normalizeGitHubRemote(remote: string): string | undefined {
  const value = remote.trim();
  const match =
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      value,
    );
  if (!match?.[1] || !match[2]) return undefined;
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export function parseWtPath(stdout: string): string | undefined {
  if (Buffer.byteLength(stdout) > MAX_WT_JSON_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const candidates = [
    object["path"],
    object["worktree_path"],
    object["worktree"] !== null && typeof object["worktree"] === "object"
      ? (object["worktree"] as Record<string, unknown>)["path"]
      : undefined,
  ].filter((candidate): candidate is string => typeof candidate === "string");
  const unique = [...new Set(candidates)];
  return unique.length === 1 && isAbsolute(unique[0]!) ? unique[0] : undefined;
}

function parseWorktreeList(output: string, expectedBranch: string): string[] {
  const records = output.includes("\0") ? output.split("\0\0") : output.split(/\n\s*\n/);
  const paths: string[] = [];
  for (const record of records) {
    const fields = record.split(output.includes("\0") ? "\0" : "\n");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    const branch = fields.find((field) => field.startsWith("branch "))?.slice("branch ".length);
    if (path !== undefined && branch === `refs/heads/${expectedBranch}` && isAbsolute(path)) {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

function withoutReason(setup: TopicSetup, state: TopicSetup["state"]): TopicSetup {
  return {
    state,
    repositoryAvailable: setup.repositoryAvailable,
    worktreeCreated: setup.worktreeCreated,
    setupCommandsRun: setup.setupCommandsRun,
  };
}

function defaultLoginShell(): string {
  try {
    const shell = userInfo().shell;
    if (typeof shell === "string" && shell.length > 0) return shell;
  } catch {
    // Fall through to the POSIX default below.
  }
  return "/bin/sh";
}

async function assertDirectory(path: string, message: string): Promise<void> {
  const value = await stat(path).catch(() => undefined);
  if (value?.isDirectory() !== true) throw failure("invalid-directory", message);
}

async function pathExists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

class ProvisionError extends Error {
  readonly status: "failed" | "timeout" | "cancelled";
  readonly code: string;

  constructor(status: "failed" | "timeout" | "cancelled", code: string, message: string) {
    super(boundMessage(message));
    this.status = status;
    this.code = code;
  }
}

function failure(code: string, message: string): ProvisionError {
  return new ProvisionError("failed", code, message);
}

function controlError(
  status: Exclude<ProcessStatus, "completed">,
  subject: string,
): ProvisionError {
  return new ProvisionError(status, status, `${subject} was ${status}.`);
}

function processFailure(subject: string, result: ProcessResult): string {
  const exit = result.exitCode === null ? "" : ` with exit code ${String(result.exitCode)}`;
  return boundMessage(`${subject}${exit}.`);
}

function asProvisionError(error: unknown): ProvisionError {
  if (error instanceof ProvisionError) return error;
  if (error instanceof WorkDataError) return failure(error.code, error.message);
  const detail = error instanceof Error ? error.message : String(error);
  return failure("provisioning-failed", `Provisioning failed: ${detail}`);
}
