export interface CommandRequest {
  command: "git" | "gh";
  args: string[];
  input?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(request: CommandRequest): CommandResult;
}

export interface PullRequestSummary {
  number: number;
  url: string;
  title: string;
  state: string;
  base: string;
  head: string;
}

export interface Inspection {
  repository: string;
  defaultBranch: string;
  base: string;
  baseRef: string;
  head: string;
  originUrl: string;
  clean: boolean;
  dirtyPaths: string[];
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  commits: Array<{ oid: string; subject: string }>;
  changedPaths: string[];
  diff: { files: number; additions: number; deletions: number; binaryFiles: number };
  existingPullRequests: PullRequestSummary[];
  availableLabels: string[];
  packageLabelCandidates: string[];
}

export interface CreateOptions {
  confirmed: boolean;
  base?: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
  labels: string[];
}

export type CreateResult =
  | {
      ok: true;
      code: "created";
      url: string;
      title: string;
      base: string;
      head: string;
      draft: boolean;
      labels: string[];
      pushed: true;
    }
  | {
      ok: false;
      code: string;
      message: string;
      [key: string]: unknown;
    };

export class WorkflowError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.details = details;
  }
}

const TITLE_PATTERN = /^[a-z][a-z0-9-]*(?:\([^)\r\n]+\))?!?: \S.+$/u;
const TEMPLATE_PLACEHOLDER_PATTERN =
  /(?:\b(?:TODO|TBD)\b|\[(?:insert|describe|description|summary)[^\]]*\]|<!--\s*(?:fill|replace|describe))/iu;
const MAX_BODY_BYTES = 65_536;
const MAX_DIAGNOSTIC_LENGTH = 4_000;

export function inspectRepository(runner: CommandRunner, requestedBase?: string): Inspection {
  const head = outputOf(runner, "git", ["branch", "--show-current"]).trim();
  if (!head) throw new WorkflowError("detached_head", "The repository is in detached HEAD state.");

  const status = outputOf(runner, "git", [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const dirtyPaths = parseNullSeparatedPaths(status);
  const originUrl = outputOf(runner, "git", ["remote", "get-url", "origin"]).trim();
  const repositoryView = parseJson<{ nameWithOwner: string; defaultBranchRef: { name: string } }>(
    outputOf(runner, "gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]),
    "repository metadata",
  );
  const base = requestedBase ?? repositoryView.defaultBranchRef.name;
  if (base === head) {
    throw new WorkflowError("same_branch", "The base and head branches must differ.", {
      base,
      head,
    });
  }

  const baseRef = resolveBaseRef(runner, base);
  const commits = parseCommits(
    outputOf(runner, "git", ["log", "--format=%H%x09%s", `${baseRef}..HEAD`]),
  );
  const changedPaths = parseNullList(
    outputOf(runner, "git", ["diff", "--name-only", "-z", `${baseRef}...HEAD`]),
  );
  const diff = parseNumstat(outputOf(runner, "git", ["diff", "--numstat", `${baseRef}...HEAD`]));

  const upstreamResult = runner.run({
    command: "git",
    args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
  });
  const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : null;
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const divergence = outputOf(runner, "git", [
      "rev-list",
      "--left-right",
      "--count",
      `${upstream}...HEAD`,
    ])
      .trim()
      .split(/\s+/u)
      .map(Number);
    behind = divergence[0] ?? null;
    ahead = divergence[1] ?? null;
  }

  const pullRequests = parseJson<GitHubPullRequest[]>(
    outputOf(runner, "gh", [
      "pr",
      "list",
      "--head",
      head,
      "--state",
      "all",
      "--limit",
      "10",
      "--json",
      "number,url,title,state,baseRefName,headRefName",
    ]),
    "pull request list",
  ).map(normalizePullRequest);

  const availableLabels = parseJson<Array<{ name: string }>>(
    outputOf(runner, "gh", ["label", "list", "--limit", "200", "--json", "name"]),
    "label list",
  )
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));

  return {
    repository: repositoryView.nameWithOwner,
    defaultBranch: repositoryView.defaultBranchRef.name,
    base,
    baseRef,
    head,
    originUrl,
    clean: dirtyPaths.length === 0,
    dirtyPaths,
    upstream,
    ahead,
    behind,
    commits,
    changedPaths,
    diff,
    existingPullRequests: pullRequests,
    availableLabels,
    packageLabelCandidates: findPackageLabelCandidates(availableLabels, changedPaths),
  };
}

export function createPullRequest(runner: CommandRunner, options: CreateOptions): CreateResult {
  try {
    validateCreateOptions(options);
    const inspection = inspectRepository(runner, options.base);

    if (!inspection.clean) {
      return failure("dirty_worktree", "The worktree has local changes.", {
        paths: inspection.dirtyPaths,
      });
    }
    if (inspection.head !== options.head) {
      return failure("head_mismatch", "The approved head is not the current branch.", {
        approvedHead: options.head,
        currentHead: inspection.head,
      });
    }
    const existing = inspection.existingPullRequests[0];
    if (existing) {
      return failure("existing_pr", "A pull request already exists for this branch.", {
        pr: existing,
      });
    }

    const missingLabels = options.labels.filter(
      (label) => !inspection.availableLabels.includes(label),
    );
    if (missingLabels.length > 0) {
      return failure("unknown_labels", "One or more approved labels do not exist.", {
        labels: missingLabels,
      });
    }

    const expectedUpstream = `origin/${inspection.head}`;
    if (inspection.upstream !== null && inspection.upstream !== expectedUpstream) {
      return failure("unsafe_upstream", "The current branch tracks a different remote branch.", {
        upstream: inspection.upstream,
        expectedUpstream,
      });
    }

    const pushArgs = inspection.upstream
      ? ["push", "origin", `HEAD:refs/heads/${inspection.head}`]
      : ["push", "-u", "origin", `HEAD:refs/heads/${inspection.head}`];
    const push = runner.run({ command: "git", args: pushArgs });
    if (push.exitCode !== 0) {
      return failure("push_rejected", "The remote rejected the push.", {
        pushed: false,
        stderr: sanitize(push.stderr),
      });
    }

    const createArgs = [
      "pr",
      "create",
      "--base",
      inspection.base,
      "--head",
      inspection.head,
      "--title",
      options.title,
      "--body-file",
      "-",
    ];
    if (options.draft) createArgs.push("--draft");
    for (const label of options.labels) createArgs.push("--label", label);

    const created = runner.run({ command: "gh", args: createArgs, input: options.body });
    if (created.exitCode !== 0) {
      return failure(
        "pr_create_failed",
        "The branch was pushed, but pull request creation failed.",
        {
          pushed: true,
          remoteBranch: `origin/${inspection.head}`,
          stderr: sanitize(created.stderr),
        },
      );
    }

    const url = created.stdout.trim();
    if (!url) {
      return failure("pr_create_failed", "GitHub did not return a pull request URL.", {
        pushed: true,
        remoteBranch: `origin/${inspection.head}`,
      });
    }

    return {
      ok: true,
      code: "created",
      url,
      title: options.title,
      base: inspection.base,
      head: inspection.head,
      draft: options.draft,
      labels: options.labels,
      pushed: true,
    };
  } catch (error) {
    if (error instanceof WorkflowError) return failure(error.code, error.message, error.details);
    throw error;
  }
}

function validateCreateOptions(options: CreateOptions): void {
  if (!options.confirmed)
    throw new WorkflowError("confirmation_required", "The --confirmed flag is required.");
  if (!options.title.trim())
    throw new WorkflowError("invalid_title", "The title must not be empty.");
  if (options.title.length > 80)
    throw new WorkflowError("invalid_title", "The title must be at most 80 characters.");
  if (!TITLE_PATTERN.test(options.title)) {
    throw new WorkflowError("invalid_title", "The title must use conventional-commit syntax.");
  }
  if (!options.body.trim()) throw new WorkflowError("invalid_body", "The body must not be empty.");
  if (Buffer.byteLength(options.body, "utf8") > MAX_BODY_BYTES) {
    throw new WorkflowError("invalid_body", `The body must be at most ${MAX_BODY_BYTES} bytes.`);
  }
  if (TEMPLATE_PLACEHOLDER_PATTERN.test(options.body)) {
    throw new WorkflowError("invalid_body", "The body contains a template placeholder.");
  }
  if (options.base === options.head) {
    throw new WorkflowError("same_branch", "The base and head branches must differ.", {
      base: options.base,
      head: options.head,
    });
  }
}

function resolveBaseRef(runner: CommandRunner, base: string): string {
  const remoteRef = `refs/remotes/origin/${base}`;
  if (
    runner.run({ command: "git", args: ["rev-parse", "--verify", "--quiet", remoteRef] })
      .exitCode === 0
  ) {
    return `origin/${base}`;
  }
  const localRef = `refs/heads/${base}`;
  if (
    runner.run({ command: "git", args: ["rev-parse", "--verify", "--quiet", localRef] })
      .exitCode === 0
  ) {
    return base;
  }
  throw new WorkflowError("base_not_found", "The base branch is not available locally.", { base });
}

type GitHubPullRequest = {
  number: number;
  url: string;
  title: string;
  state: string;
  baseRefName: string;
  headRefName: string;
};

function normalizePullRequest(pr: GitHubPullRequest): PullRequestSummary {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    state: pr.state,
    base: pr.baseRefName,
    head: pr.headRefName,
  };
}

function parseCommits(output: string): Array<{ oid: string; subject: string }> {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("\t");
      if (separator < 0)
        throw new WorkflowError("invalid_git_output", "Git returned an invalid commit list.");
      return { oid: line.slice(0, separator), subject: line.slice(separator + 1) };
    });
}

function parseNumstat(output: string): Inspection["diff"] {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const [added, deleted] = line.split("\t");
    files += 1;
    if (added === "-" || deleted === "-") {
      binaryFiles += 1;
    } else {
      additions += Number(added ?? 0);
      deletions += Number(deleted ?? 0);
    }
  }
  return { files, additions, deletions, binaryFiles };
}

function parseNullSeparatedPaths(output: string): string[] {
  const entries = parseNullList(output);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/u.test(status)) {
      const source = entries[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return [...new Set(paths)].sort();
}

function parseNullList(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function findPackageLabelCandidates(labels: string[], changedPaths: string[]): string[] {
  const pathSegments = new Set(changedPaths.flatMap((path) => path.toLowerCase().split("/")));
  return labels.filter((label) => {
    const marker = label.toLowerCase().indexOf("package:");
    if (marker < 0) return false;
    return pathSegments.has(
      label
        .slice(marker + "package:".length)
        .trim()
        .toLowerCase(),
    );
  });
}

function outputOf(
  runner: CommandRunner,
  command: CommandRequest["command"],
  args: string[],
): string {
  const result = runner.run({ command, args });
  if (result.exitCode !== 0) {
    throw new WorkflowError("command_failed", `${command} ${args[0] ?? ""} failed.`, {
      command,
      args,
      stderr: sanitize(result.stderr),
    });
  }
  return result.stdout;
}

function parseJson<T>(value: string, description: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new WorkflowError("invalid_command_output", `Could not parse ${description}.`);
  }
}

function sanitize(value: string): string {
  return value.trim().slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function failure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): CreateResult {
  return { ok: false, code, message, ...details };
}
