import { stat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { agentGitConfigGlobal } from "../../../lib/agent-git-config.ts";
import {
  AbsolutePath,
  Branch,
  FullCommitSha,
  GitFailure,
  Repository,
  decodeAbsolutePath,
  decodeBranch,
  decodeFullCommitSha,
  decodeRepository,
  type StartPoint,
} from "../../domain/index.ts";
import {
  GIT_LOCAL_ENVIRONMENT_VARIABLES,
  ProcessExecutor,
  type ProcessResult,
} from "../process/index.ts";

const READ_TIMEOUT_MS = 10_000;
const REBASE_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 8 * 1_024;

type GitRequirements = ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;
type GitEffect<A> = Effect.Effect<A, GitFailure, GitRequirements>;

export type GitRevision = { readonly branch: Branch } | { readonly commit: FullCommitSha };

export interface ResolvedStartPoint {
  readonly repository: Repository;
  readonly repositoryRoot: AbsolutePath;
  readonly startPoint: StartPoint;
}

export interface GitWorktree {
  readonly path: AbsolutePath;
  readonly branch?: Branch;
  readonly commit: FullCommitSha;
  readonly bare: boolean;
  readonly detached: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

export type GitOperationKind = "rebase" | "merge" | "cherry-pick" | "revert";
export interface GitOperation {
  readonly kind: GitOperationKind;
  readonly conflict: boolean;
}
export interface GitWorktreeInspection {
  readonly clean: boolean;
  readonly checkedOutBranch?: Branch;
  readonly operation?: GitOperation;
}

export type IntegrationStatus =
  | { readonly kind: "current"; readonly ahead: number; readonly behind: 0 }
  | { readonly kind: "behind"; readonly ahead: number; readonly behind: number }
  | { readonly kind: "conflict"; readonly ahead: number; readonly behind: number }
  | {
      readonly kind: "unknown";
      readonly ahead?: number;
      readonly behind?: number;
      readonly diagnostic: string;
    };

export interface ValidateWorktreeInput {
  readonly repositoryPath: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly repository: Repository;
  readonly branch: Branch;
  readonly commit?: FullCommitSha;
}

export interface GuardedRebaseInput {
  readonly worktreePath: AbsolutePath;
  readonly branch: Branch;
  readonly targetBranch: Branch;
}

/** Semantic local Git questions and guarded commands. No method accepts Git arguments. */
export interface GitControl {
  readonly resolveStartPoint: (input: {
    readonly sourceCheckout: AbsolutePath;
    readonly revision: string;
    readonly expectedRepository?: Repository;
  }) => GitEffect<ResolvedStartPoint>;
  readonly readBranchTip: (
    repositoryPath: AbsolutePath,
    branch: Branch,
  ) => GitEffect<FullCommitSha>;
  readonly readBranchTips: (
    repositoryPath: AbsolutePath,
    branches: ReadonlyArray<Branch>,
  ) => GitEffect<ReadonlyMap<Branch, FullCommitSha>>;
  readonly contains: (
    repositoryPath: AbsolutePath,
    ancestor: GitRevision,
    descendant: GitRevision,
  ) => GitEffect<boolean>;
  readonly listWorktrees: (repositoryPath: AbsolutePath) => GitEffect<ReadonlyArray<GitWorktree>>;
  readonly validateWorktree: (input: ValidateWorktreeInput) => GitEffect<GitWorktree>;
  readonly worktreePresent: (worktreePath: AbsolutePath) => GitEffect<boolean>;
  readonly inspectWorktree: (worktreePath: AbsolutePath) => GitEffect<GitWorktreeInspection>;
  readonly integrationStatus: (
    repositoryPath: AbsolutePath,
    branch: Branch,
    targetBranch: Branch,
  ) => GitEffect<IntegrationStatus>;
  readonly createBranch: (
    repositoryPath: AbsolutePath,
    branch: Branch,
    commit: FullCommitSha,
  ) => GitEffect<void>;
  readonly guardedRebase: (input: GuardedRebaseInput) => GitEffect<void>;
  readonly withStableTips: <A>(
    repositoryPath: AbsolutePath,
    branches: ReadonlyArray<Branch>,
    plan: (tips: ReadonlyMap<Branch, FullCommitSha>) => GitEffect<A>,
  ) => GitEffect<A>;
}

export const GitControl = Context.Service<GitControl>("Work/GitControl");

function failure(
  reason: "unavailable" | "invalid-state" | "race" | "conflict" | "ambiguous",
  message: string,
  cause: unknown,
): GitFailure {
  return new GitFailure({ reason, message, internalCause: cause });
}

export const makeGitControl = (processes: ProcessExecutor): GitControl => {
  const run = (
    cwd: AbsolutePath,
    args: ReadonlyArray<string>,
    options: {
      readonly timeoutMs?: number;
      readonly environment?: Readonly<Record<string, string>>;
    } = {},
  ): GitEffect<ProcessResult> =>
    processes
      .run({
        command: { _tag: "Executable", executable: "git", arguments: args },
        cwd,
        timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        unsetEnvironment: GIT_LOCAL_ENVIRONMENT_VARIABLES,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      })
      .pipe(
        Effect.mapError((cause) => failure("unavailable", "Git could not run.", cause)),
        Effect.flatMap((result) => {
          if (result.status === "timeout") {
            return Effect.fail(failure("unavailable", "Git timed out.", result));
          }
          if (result.status === "cancelled") {
            return Effect.fail(failure("unavailable", "Git was interrupted.", result));
          }
          if (result.outputTruncated) {
            return Effect.fail(failure("unavailable", "Git output exceeded its limit.", result));
          }
          return Effect.succeed(result);
        }),
      );

  const successful = (
    cwd: AbsolutePath,
    args: ReadonlyArray<string>,
    message: string,
  ): GitEffect<ProcessResult> =>
    run(cwd, args).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed(result)
          : Effect.fail(failure("invalid-state", message, result)),
      ),
    );

  const readBranchTip = (path: AbsolutePath, branch: Branch): GitEffect<FullCommitSha> =>
    successful(
      path,
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`],
      "The local Branch does not have a readable commit tip.",
    ).pipe(
      Effect.flatMap((result) => decodeSha(result.stdout, "Git returned an invalid Branch tip.")),
    );

  const readBranchTips = (
    path: AbsolutePath,
    branches: ReadonlyArray<Branch>,
  ): GitEffect<ReadonlyMap<Branch, FullCommitSha>> => {
    const unique = [...new Set(branches)];
    return Effect.forEach(unique, (branch) =>
      readBranchTip(path, branch).pipe(Effect.map((tip) => [branch, tip] as const)),
    ).pipe(Effect.map((entries) => new Map(entries)));
  };

  const withStableTips: GitControl["withStableTips"] = (path, branches, plan) =>
    readBranchTips(path, branches).pipe(
      Effect.flatMap((before) =>
        plan(before).pipe(
          Effect.flatMap((value) =>
            readBranchTips(path, branches).pipe(
              Effect.flatMap((after) =>
                sameTips(before, after)
                  ? Effect.succeed(value)
                  : Effect.fail(
                      failure("race", "A Branch tip moved while the Git plan was calculated.", {
                        before,
                        after,
                      }),
                    ),
              ),
            ),
          ),
        ),
      ),
    );

  const inspectOperation = (path: AbsolutePath): GitEffect<GitOperation | undefined> =>
    successful(
      path,
      ["rev-parse", "--absolute-git-dir"],
      "The Worktree Git directory is unavailable.",
    ).pipe(
      Effect.flatMap((result) => {
        const gitDirectory = result.stdout.trim();
        if (!isAbsolute(gitDirectory)) {
          return Effect.fail(
            failure("invalid-state", "Git returned an invalid Git directory.", result),
          );
        }
        return Effect.tryPromise({
          try: async () => {
            const candidates: ReadonlyArray<readonly [GitOperationKind, string]> = [
              ["rebase", "rebase-merge"],
              ["rebase", "rebase-apply"],
              ["merge", "MERGE_HEAD"],
              ["cherry-pick", "CHERRY_PICK_HEAD"],
              ["revert", "REVERT_HEAD"],
            ];
            for (const [kind, marker] of candidates) {
              if (await exists(resolve(gitDirectory, marker))) return kind;
            }
            return undefined;
          },
          catch: (cause) =>
            failure("unavailable", "The Git Operation State is unavailable.", cause),
        }).pipe(
          Effect.flatMap((kind) => {
            if (kind === undefined) return Effect.succeed(undefined);
            return successful(
              path,
              ["ls-files", "--unmerged"],
              "Git conflicts are unavailable.",
            ).pipe(Effect.map((unmerged) => ({ kind, conflict: unmerged.stdout.length > 0 })));
          }),
        );
      }),
    );

  const inspectWorktree = (path: AbsolutePath): GitEffect<GitWorktreeInspection> =>
    Effect.all({
      operation: inspectOperation(path),
      branch: run(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      status: successful(
        path,
        ["status", "--porcelain", "--untracked-files=normal"],
        "The Worktree cleanliness is unavailable.",
      ),
    }).pipe(
      Effect.flatMap(({ operation, branch, status }) => {
        const branchName = branch.exitCode === 0 ? branch.stdout.trim() : undefined;
        return branchName === undefined || branchName.length === 0
          ? Effect.succeed({
              clean: status.stdout.length === 0,
              ...(operation ? { operation } : {}),
            })
          : decodeValue(Branch, branchName, "Git returned an invalid checked-out Branch.").pipe(
              Effect.map((checkedOutBranch) => ({
                clean: status.stdout.length === 0,
                checkedOutBranch,
                ...(operation ? { operation } : {}),
              })),
            );
      }),
    );

  const integrationStatus = (
    path: AbsolutePath,
    branch: Branch,
    targetBranch: Branch,
  ): GitEffect<IntegrationStatus> =>
    withStableTips(path, [branch, targetBranch], (tips): GitEffect<IntegrationStatus> => {
      const topic = tips.get(branch)!;
      const target = tips.get(targetBranch)!;
      if (topic === target) {
        return Effect.succeed<IntegrationStatus>({ kind: "current", ahead: 0, behind: 0 });
      }
      return successful(
        path,
        ["rev-list", "--left-right", "--count", `${target}...${topic}`],
        "Git could not count the Integration Chain edge.",
      ).pipe(
        Effect.flatMap((countsResult) => {
          const counts = parseCounts(countsResult.stdout);
          if (counts === undefined) {
            return Effect.succeed<IntegrationStatus>({
              kind: "unknown",
              diagnostic: "Git returned invalid Integration Status counts.",
            });
          }
          if (counts.behind === 0) {
            return Effect.succeed<IntegrationStatus>({
              kind: "current",
              ahead: counts.ahead,
              behind: 0,
            });
          }
          return run(path, ["merge-base", target, topic]).pipe(
            Effect.flatMap((related): GitEffect<IntegrationStatus> => {
              if (related.exitCode !== 0) {
                return Effect.succeed({
                  kind: "unknown",
                  ...counts,
                  diagnostic: "The Topic and its Integration Target have unrelated histories.",
                });
              }
              return run(path, ["merge-tree", "--write-tree", topic, target]).pipe(
                Effect.map((merge): IntegrationStatus => {
                  if (merge.exitCode === 0) return { kind: "behind", ...counts };
                  if (merge.exitCode === 1) return { kind: "conflict", ...counts };
                  return {
                    kind: "unknown",
                    ...counts,
                    diagnostic: "Git could not predict the Integration Chain conflict.",
                  };
                }),
              );
            }),
          );
        }),
      );
    });

  const listWorktrees = (path: AbsolutePath): GitEffect<ReadonlyArray<GitWorktree>> =>
    successful(
      path,
      ["worktree", "list", "--porcelain", "-z"],
      "Git worktrees are unavailable.",
    ).pipe(Effect.flatMap((result) => parseWorktrees(result.stdout)));

  return {
    resolveStartPoint: ({ sourceCheckout, revision, expectedRepository }) => {
      if (revision.length === 0 || revision.length > 1_000 || revision.includes("\0")) {
        return Effect.fail(
          failure("invalid-state", "The Start Point revision is invalid.", revision),
        );
      }
      return Effect.tryPromise({
        try: async () => {
          if (!(await stat(sourceCheckout)).isDirectory()) throw new Error("not a directory");
          return realpath(sourceCheckout);
        },
        catch: (cause) =>
          failure("invalid-state", "The Source checkout is not a directory.", cause),
      }).pipe(
        Effect.flatMap((source) => decodePath(source)),
        Effect.flatMap((source) =>
          Effect.all({
            root: successful(
              source,
              ["rev-parse", "--show-toplevel"],
              "The Source checkout is not a Git worktree.",
            ),
            origin: successful(
              source,
              ["remote", "get-url", "origin"],
              "The Source checkout origin is unavailable.",
            ),
            commit: successful(
              source,
              ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
              "The Start Point does not resolve to one commit.",
            ),
          }),
        ),
        Effect.flatMap(({ root, origin, commit }) =>
          Effect.all({
            repositoryRoot: Effect.tryPromise({
              try: () => realpath(root.stdout.trim()),
              catch: (cause) =>
                failure("invalid-state", "Git returned an invalid repository root.", cause),
            }).pipe(Effect.flatMap(decodePath)),
            repository: parseGitHubRepository(origin.stdout),
            commit: decodeSha(commit.stdout, "Git returned an invalid Start Point commit."),
          }),
        ),
        Effect.flatMap(({ repositoryRoot, repository, commit }) => {
          if (
            expectedRepository !== undefined &&
            expectedRepository.toLowerCase() !== repository.toLowerCase()
          ) {
            return Effect.fail(
              failure(
                "invalid-state",
                "The Source checkout belongs to another repository.",
                repository,
              ),
            );
          }
          return Effect.succeed({
            repository,
            repositoryRoot,
            startPoint: { commit, sourceCheckout: repositoryRoot },
          });
        }),
      );
    },
    readBranchTip,
    readBranchTips,
    contains: (path, ancestor, descendant) =>
      run(path, ["merge-base", "--is-ancestor", revisionOf(ancestor), revisionOf(descendant)]).pipe(
        Effect.flatMap((result) => {
          if (result.exitCode === 0) return Effect.succeed(true);
          if (result.exitCode === 1) return Effect.succeed(false);
          return Effect.fail(
            failure("ambiguous", "Git could not answer the ancestry question.", result),
          );
        }),
      ),
    listWorktrees,
    worktreePresent: (path) =>
      Effect.tryPromise({
        try: () =>
          stat(path).then(
            (value) => value.isDirectory(),
            (cause: NodeJS.ErrnoException) => {
              if (cause.code === "ENOENT") return false;
              throw cause;
            },
          ),
        catch: (cause) => failure("unavailable", "The Worktree presence is unavailable.", cause),
      }),
    validateWorktree: (input) =>
      listWorktrees(input.repositoryPath).pipe(
        Effect.flatMap((worktrees) => {
          const matches = worktrees.filter((item) => item.path === input.worktreePath);
          if (matches.length !== 1) {
            return Effect.fail(
              failure("invalid-state", "The Worktree is not registered exactly once.", matches),
            );
          }
          const item = matches[0]!;
          if (
            item.branch !== input.branch ||
            (input.commit !== undefined && item.commit !== input.commit)
          ) {
            return Effect.fail(
              failure("invalid-state", "The Worktree has another Branch or commit.", item),
            );
          }
          return successful(
            input.worktreePath,
            ["remote", "get-url", "origin"],
            "The Worktree origin is unavailable.",
          ).pipe(
            Effect.flatMap((origin) => parseGitHubRepository(origin.stdout)),
            Effect.flatMap((repository) =>
              repository.toLowerCase() === input.repository.toLowerCase()
                ? Effect.succeed(item)
                : Effect.fail(
                    failure(
                      "invalid-state",
                      "The Worktree belongs to another repository.",
                      repository,
                    ),
                  ),
            ),
          );
        }),
      ),
    inspectWorktree,
    integrationStatus,
    createBranch: (path, branch, commit) =>
      run(path, ["branch", "--no-track", branch, commit]).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(
                failure(
                  "invalid-state",
                  "Git could not create the Branch at the exact commit.",
                  result,
                ),
              ),
        ),
      ),
    guardedRebase: ({ worktreePath, branch, targetBranch }) =>
      withStableTips(worktreePath, [branch, targetBranch], () =>
        Effect.all({
          state: inspectWorktree(worktreePath),
          status: integrationStatus(worktreePath, branch, targetBranch),
        }).pipe(
          Effect.flatMap(({ state, status }) => {
            if (
              !state.clean ||
              state.checkedOutBranch !== branch ||
              state.operation !== undefined
            ) {
              return Effect.fail(
                failure("invalid-state", "The Worktree is not eligible for rebase.", state),
              );
            }
            if (status.kind !== "behind") {
              return Effect.fail(
                failure("invalid-state", "Only a Behind Topic Branch can be rebased.", status),
              );
            }
            return Effect.void;
          }),
        ),
      ).pipe(
        Effect.andThen(
          run(worktreePath, ["rebase", targetBranch], {
            timeoutMs: REBASE_TIMEOUT_MS,
            environment: {
              GIT_CONFIG_GLOBAL: agentGitConfigGlobal(),
              GIT_EDITOR: "true",
              GIT_SEQUENCE_EDITOR: "true",
              GIT_TERMINAL_PROMPT: "0",
              GCM_INTERACTIVE: "never",
            },
          }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : Effect.fail(failure("conflict", "Git could not rebase the Topic Branch.", result)),
        ),
      ),
    withStableTips,
  };
};

export const GitControlLive = Layer.effect(
  GitControl,
  Effect.gen(function* () {
    return makeGitControl(yield* ProcessExecutor);
  }),
);

function decodeValue<A>(
  schema: { readonly make: (value: string) => A },
  value: string,
  message: string,
): Effect.Effect<A, GitFailure> {
  return Effect.try({
    try: () => schema.make(value),
    catch: (cause) => failure("ambiguous", message, cause),
  });
}

function decodePath(value: string): Effect.Effect<AbsolutePath, GitFailure> {
  return Effect.try({
    try: () => decodeAbsolutePath(value),
    catch: (cause) => failure("ambiguous", "Git returned an invalid absolute path.", cause),
  });
}

function decodeSha(value: string, message: string): Effect.Effect<FullCommitSha, GitFailure> {
  return Effect.try({
    try: () => decodeFullCommitSha(value.trim().split("\n", 1)[0]?.toLowerCase()),
    catch: (cause) => failure("ambiguous", message, cause),
  });
}

function parseGitHubRepository(remote: string): Effect.Effect<Repository, GitFailure> {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      remote.trim(),
    );
  const name = match?.[2]?.replace(/\.git$/i, "");
  if (match?.[1] === undefined || name === undefined) {
    return Effect.fail(
      failure("invalid-state", "The Git origin is not a GitHub repository URL.", remote),
    );
  }
  return Effect.try({
    try: () => decodeRepository(`${match[1]}/${name}`),
    catch: (cause) =>
      failure("invalid-state", "The Git origin repository identity is invalid.", cause),
  });
}

function revisionOf(reference: GitRevision): string {
  return "branch" in reference ? `refs/heads/${reference.branch}^{commit}` : reference.commit;
}

function sameTips(
  left: ReadonlyMap<Branch, FullCommitSha>,
  right: ReadonlyMap<Branch, FullCommitSha>,
): boolean {
  return left.size === right.size && [...left].every(([branch, tip]) => right.get(branch) === tip);
}

function parseCounts(
  output: string,
): { readonly ahead: number; readonly behind: number } | undefined {
  const [behind, ahead] = output.trim().split(/\s+/, 2).map(Number);
  return Number.isSafeInteger(behind) && Number.isSafeInteger(ahead) && behind! >= 0 && ahead! >= 0
    ? { behind: behind!, ahead: ahead! }
    : undefined;
}

function parseWorktrees(output: string): Effect.Effect<ReadonlyArray<GitWorktree>, GitFailure> {
  return Effect.try({
    try: () => {
      const records = output.split("\0\0").filter((record) => record.length > 0);
      return records.map((record) => {
        const fields = record.split("\0");
        const value = (prefix: string) =>
          fields.find((field) => field.startsWith(prefix))?.slice(prefix.length);
        const path = decodeAbsolutePath(value("worktree "));
        const commit = decodeFullCommitSha(value("HEAD ")?.toLowerCase());
        const branchRef = value("branch ");
        const branch = branchRef?.startsWith("refs/heads/")
          ? decodeBranch(branchRef.slice("refs/heads/".length))
          : undefined;
        return {
          path,
          commit,
          ...(branch === undefined ? {} : { branch }),
          bare: fields.includes("bare"),
          detached: fields.includes("detached"),
          locked: fields.some((field) => field === "locked" || field.startsWith("locked ")),
          prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
        };
      });
    },
    catch: (cause) => failure("ambiguous", "Git returned an invalid Worktree list.", cause),
  });
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
