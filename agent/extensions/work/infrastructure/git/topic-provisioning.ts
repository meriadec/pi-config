import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { AbsolutePath, GitFailure, type Branch, type Repository } from "../../domain/index.ts";
import type { ProvisioningControl } from "../../application/provisioning/index.ts";
import {
  GIT_LOCAL_ENVIRONMENT_VARIABLES,
  ProcessExecutor,
  type ProcessResult,
} from "../process/index.ts";

const TIMEOUT_MS = 30_000;
const OUTPUT_BYTES = 64 * 1_024;

/** Builds the real Git/gh/wt provisioning adapter with the process platform captured once. */
export const makeTopicProvisioningControl = Effect.gen(function* () {
  const processes = yield* ProcessExecutor;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = (input: {
    readonly executable: string;
    readonly arguments: ReadonlyArray<string>;
    readonly cwd: AbsolutePath;
  }) =>
    Effect.scoped(
      processes.run({
        command: {
          _tag: "Executable",
          executable: input.executable,
          arguments: input.arguments,
        },
        cwd: input.cwd,
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: OUTPUT_BYTES,
        ...(input.executable === "git"
          ? { unsetEnvironment: GIT_LOCAL_ENVIRONMENT_VARIABLES }
          : {}),
      }),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.mapError((cause) =>
        failure("unavailable", "Provisioning command could not run.", cause),
      ),
      Effect.flatMap((result) =>
        result.status === "completed" && !result.outputTruncated
          ? Effect.succeed(result)
          : Effect.fail(failure("unavailable", "Provisioning command did not complete.", result)),
      ),
    );

  const git = (cwd: AbsolutePath, args: ReadonlyArray<string>) =>
    run({ executable: "git", arguments: args, cwd });

  const validateBase = (path: AbsolutePath, repository: Repository) =>
    Effect.all({
      root: git(path, ["rev-parse", "--show-toplevel"]),
      origin: git(path, ["remote", "get-url", "origin"]),
    }).pipe(
      Effect.flatMap(({ root, origin }) =>
        Effect.tryPromise({
          try: async () => ({
            expected: await realpath(path),
            actual: await realpath(root.stdout.trim()),
          }),
          catch: (cause) => failure("invalid-state", "Base checkout path is invalid.", cause),
        }).pipe(
          Effect.flatMap(({ expected, actual }) =>
            root.exitCode === 0 &&
            origin.exitCode === 0 &&
            expected === actual &&
            normalizeRemote(origin.stdout) === repository.toLowerCase()
              ? Effect.void
              : Effect.fail(
                  failure("invalid-state", "Base checkout belongs to another repository.", {
                    root,
                    origin,
                  }),
                ),
          ),
        ),
      ),
    );

  const control: ProvisioningControl = {
    inspectBaseCheckout: (workBase, baseCheckout, repository) =>
      Effect.tryPromise({
        try: async () => {
          const base = await stat(workBase);
          if (!base.isDirectory()) throw new Error("workBase is not a directory");
          const checkout = await stat(baseCheckout).catch(() => undefined);
          if (checkout === undefined) return "missing" as const;
          if (!checkout.isDirectory()) throw new Error("Base checkout is not a directory");
          return "valid" as const;
        },
        catch: (cause) => failure("invalid-state", "Work Base checkout is invalid.", cause),
      }).pipe(
        Effect.flatMap((state) =>
          state === "missing"
            ? Effect.succeed(state)
            : validateBase(baseCheckout, repository).pipe(Effect.as("valid" as const)),
        ),
      ),
    cloneRepository: (workBase, baseCheckout, repository) =>
      run({
        executable: "gh",
        arguments: ["repo", "clone", repository, baseCheckout],
        cwd: workBase,
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.void
            : validateBase(baseCheckout, repository).pipe(
                Effect.catch(() =>
                  Effect.fail(failure("invalid-state", "Repository clone failed.", result)),
                ),
              ),
        ),
      ),
    validateStartPoint: (baseCheckout, startPoint) =>
      Effect.all({
        base: git(baseCheckout, ["rev-parse", "--git-common-dir"]),
        source: git(startPoint.sourceCheckout, ["rev-parse", "--git-common-dir"]),
        commit: git(baseCheckout, ["cat-file", "-t", startPoint.commit]),
      }).pipe(
        Effect.flatMap(({ base, source, commit }) =>
          Effect.tryPromise({
            try: async () => ({
              base: await realpath(resolve(baseCheckout, base.stdout.trim())),
              source: await realpath(resolve(startPoint.sourceCheckout, source.stdout.trim())),
            }),
            catch: (cause) => failure("invalid-state", "Start Point repository is invalid.", cause),
          }).pipe(
            Effect.flatMap((directories) =>
              base.exitCode === 0 &&
              source.exitCode === 0 &&
              commit.exitCode === 0 &&
              commit.stdout.trim() === "commit" &&
              directories.base === directories.source
                ? Effect.void
                : Effect.fail(
                    failure(
                      "invalid-state",
                      "Start Point is not an exact commit in the Base repository.",
                      { base, source, commit },
                    ),
                  ),
            ),
          ),
        ),
      ),
    ensureBranch: (baseCheckout, branch, commit) =>
      git(baseCheckout, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]).pipe(
        Effect.flatMap((tip) => {
          if (tip.exitCode === 0) {
            return tip.stdout.trim().toLowerCase() === commit
              ? Effect.void
              : Effect.fail(failure("conflict", "Topic Branch exists at another commit.", tip));
          }
          return git(baseCheckout, ["branch", "--no-track", branch, commit]).pipe(
            Effect.flatMap((created) =>
              created.exitCode === 0
                ? Effect.void
                : git(baseCheckout, [
                    "rev-parse",
                    "--verify",
                    `refs/heads/${branch}^{commit}`,
                  ]).pipe(
                    Effect.flatMap((reconciled) =>
                      reconciled.exitCode === 0 && reconciled.stdout.trim().toLowerCase() === commit
                        ? Effect.void
                        : Effect.fail(
                            failure(
                              "conflict",
                              "Topic Branch could not be created exactly.",
                              created,
                            ),
                          ),
                    ),
                  ),
            ),
          );
        }),
      ),
    discoverWorktree: (baseCheckout, branch) =>
      git(baseCheckout, ["worktree", "list", "--porcelain", "-z"]).pipe(
        Effect.flatMap((result) => {
          if (result.exitCode !== 0) {
            return Effect.fail(failure("unavailable", "Git worktrees are unavailable.", result));
          }
          const paths = parseWorktreePaths(result.stdout, branch);
          return paths.length <= 1
            ? Effect.succeed(paths[0])
            : Effect.fail(
                failure("ambiguous", "More than one Worktree uses the Topic Branch.", paths),
              );
        }),
      ),
    createWorktree: (baseCheckout, branch, allowBranchCreation) => {
      const switchWorktree = (create: boolean) =>
        run({
          executable: "wt",
          arguments: ["switch", ...(create ? ["--create"] : []), branch, "--format", "json"],
          cwd: baseCheckout,
        });
      return switchWorktree(false).pipe(
        Effect.flatMap((initial) => {
          const initialPath = parseWtPath(initial);
          if (initial.exitCode === 0 && initialPath !== undefined) {
            return Effect.succeed(initialPath);
          }
          if (!allowBranchCreation) {
            return Effect.fail(
              failure("invalid-state", "wt did not create one valid Worktree.", initial),
            );
          }
          return switchWorktree(true).pipe(
            Effect.flatMap((created) => {
              const path = parseWtPath(created);
              return created.exitCode === 0 && path !== undefined
                ? Effect.succeed(path)
                : Effect.fail(
                    failure("invalid-state", "wt did not create one valid Worktree.", created),
                  );
            }),
          );
        }),
      );
    },
    validateWorktree: ({ baseCheckout, worktreePath, repository, branch, commit }) =>
      Effect.all({
        worktrees: control.discoverWorktree(baseCheckout, branch),
        origin: git(worktreePath, ["remote", "get-url", "origin"]),
        tip: git(worktreePath, ["rev-parse", "--verify", "HEAD^{commit}"]),
      }).pipe(
        Effect.flatMap(({ worktrees, origin, tip }) =>
          worktrees === worktreePath &&
          origin.exitCode === 0 &&
          tip.exitCode === 0 &&
          normalizeRemote(origin.stdout) === repository.toLowerCase() &&
          (commit === undefined || tip.stdout.trim().toLowerCase() === commit)
            ? Effect.void
            : Effect.fail(
                failure("invalid-state", "Topic Worktree validation failed.", { origin, tip }),
              ),
        ),
      ),
  };
  return control;
});

function failure(
  reason: "unavailable" | "invalid-state" | "race" | "conflict" | "ambiguous",
  message: string,
  cause: unknown,
) {
  return new GitFailure({ reason, message, internalCause: cause });
}

function normalizeRemote(remote: string): string | undefined {
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)\/?$/i.exec(
      remote.trim(),
    );
  const name = match?.[2]?.replace(/\.git$/i, "");
  return match?.[1] === undefined || name === undefined
    ? undefined
    : `${match[1]}/${name}`.toLowerCase();
}

function parseWorktreePaths(output: string, branch: Branch): ReadonlyArray<AbsolutePath> {
  const values = output.split("\0\0").flatMap((record) => {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
    const reference = fields.find((field) => field.startsWith("branch "))?.slice(7);
    return path !== undefined && reference === `refs/heads/${branch}` ? [path] : [];
  });
  return [...new Set(values)].map((path) => AbsolutePath.make(path));
}

function parseWtPath(result: ProcessResult): AbsolutePath | undefined {
  if (result.outputTruncated) return undefined;
  try {
    const value = JSON.parse(result.stdout) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const nested =
      record["worktree"] !== null && typeof record["worktree"] === "object"
        ? (record["worktree"] as Record<string, unknown>)["path"]
        : undefined;
    const paths = [record["path"], record["worktree_path"], nested].filter(
      (path): path is string => typeof path === "string",
    );
    return new Set(paths).size === 1 ? Schema.decodeUnknownSync(AbsolutePath)(paths[0]) : undefined;
  } catch {
    return undefined;
  }
}
