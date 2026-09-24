import { describe, expect, test } from "bun:test";
import {
  createPullRequest,
  inspectRepository,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type CreateOptions,
} from "./workflow.ts";

class FakeRunner implements CommandRunner {
  readonly requests: CommandRequest[] = [];
  readonly responses = new Map<string, CommandResult[]>();

  respond(
    command: CommandRequest["command"],
    args: string[],
    stdout = "",
    exitCode = 0,
    stderr = "",
  ): this {
    const key = requestKey(command, args);
    const queue = this.responses.get(key) ?? [];
    queue.push({ exitCode, stdout, stderr });
    this.responses.set(key, queue);
    return this;
  }

  run(request: CommandRequest): CommandResult {
    this.requests.push(request);
    const queue = this.responses.get(requestKey(request.command, request.args));
    const response = queue?.shift();
    if (!response)
      throw new Error(`Unexpected command: ${request.command} ${request.args.join(" ")}`);
    return response;
  }
}

function preparedRunner(
  options: { status?: string; pullRequests?: string; upstream?: string | null } = {},
): FakeRunner {
  const runner = new FakeRunner()
    .respond("git", ["branch", "--show-current"], "feature\n")
    .respond(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      options.status ?? "",
    )
    .respond("git", ["remote", "get-url", "origin"], "git@github.com:acme/widgets.git\n")
    .respond(
      "gh",
      ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"],
      '{"nameWithOwner":"acme/widgets","defaultBranchRef":{"name":"main"}}\n',
    )
    .respond("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"])
    .respond(
      "git",
      ["log", "--format=%H%x09%s", "origin/main..HEAD"],
      "abc123\tfix(web): improve forms\n",
    )
    .respond(
      "git",
      ["diff", "--name-only", "-z", "origin/main...HEAD"],
      "packages/web/form.tsx\0README.md\0",
    )
    .respond(
      "git",
      ["diff", "--numstat", "origin/main...HEAD"],
      "4\t1\tpackages/web/form.tsx\n1\t0\tREADME.md\n",
    )
    .respond(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      options.upstream ?? "",
      options.upstream === undefined || options.upstream === null ? 1 : 0,
    )
    .respond(
      "gh",
      [
        "pr",
        "list",
        "--head",
        "feature",
        "--state",
        "all",
        "--limit",
        "10",
        "--json",
        "number,url,title,state,baseRefName,headRefName",
      ],
      options.pullRequests ?? "[]\n",
    )
    .respond(
      "gh",
      ["label", "list", "--limit", "200", "--json", "name"],
      '[{"name":"🎨 package:web"},{"name":"maintenance"}]\n',
    );

  if (options.upstream !== undefined && options.upstream !== null) {
    runner.respond(
      "git",
      ["rev-list", "--left-right", "--count", `${options.upstream}...HEAD`],
      "2\t3\n",
    );
  }
  return runner;
}

function createOptions(overrides: Partial<CreateOptions> = {}): CreateOptions {
  return {
    confirmed: true,
    head: "feature",
    title: "fix(web): improve form navigation",
    body: "Improve keyboard navigation for form controls.\n\n- Skip passive controls.\n",
    draft: false,
    labels: ["🎨 package:web"],
    ...overrides,
  };
}

describe("pull request inspection", () => {
  test("normalizes bounded repository facts and package label candidates", () => {
    const inspection = inspectRepository(preparedRunner({ upstream: "origin/feature" }));

    expect(inspection).toMatchObject({
      repository: "acme/widgets",
      base: "main",
      baseRef: "origin/main",
      head: "feature",
      clean: true,
      upstream: "origin/feature",
      ahead: 3,
      behind: 2,
      commits: [{ oid: "abc123", subject: "fix(web): improve forms" }],
      changedPaths: ["packages/web/form.tsx", "README.md"],
      diff: { files: 2, additions: 5, deletions: 1, binaryFiles: 0 },
      packageLabelCandidates: ["🎨 package:web"],
    });
  });
});

describe("pull request creation", () => {
  test("pushes the same-named branch and streams the approved body to GitHub", () => {
    const runner = preparedRunner()
      .respond("git", ["push", "-u", "origin", "HEAD:refs/heads/feature"], "")
      .respond(
        "gh",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "feature",
          "--title",
          "fix(web): improve form navigation",
          "--body-file",
          "-",
          "--label",
          "🎨 package:web",
        ],
        "https://github.com/acme/widgets/pull/42\n",
      );
    const options = createOptions();

    const result = createPullRequest(runner, options);

    expect(result).toEqual({
      ok: true,
      code: "created",
      url: "https://github.com/acme/widgets/pull/42",
      title: options.title,
      base: "main",
      head: "feature",
      draft: false,
      labels: ["🎨 package:web"],
      pushed: true,
    });
    const createRequest = runner.requests.find(
      ({ command, args }) => command === "gh" && args[0] === "pr" && args[1] === "create",
    );
    expect(createRequest?.input).toBe(options.body);
  });

  test("stops before network mutation when the worktree is dirty", () => {
    const runner = preparedRunner({ status: " M src/form.ts\0?? notes.txt\0" });

    const result = createPullRequest(runner, createOptions());

    expect(result).toMatchObject({
      ok: false,
      code: "dirty_worktree",
      paths: ["notes.txt", "src/form.ts"],
    });
    expect(
      runner.requests.some(({ args }) => args[0] === "push" || args[1] === "create"),
    ).toBeFalse();
  });

  test("returns the existing pull request instead of pushing or creating a duplicate", () => {
    const runner = preparedRunner({
      pullRequests:
        '[{"number":17,"url":"https://github.com/acme/widgets/pull/17","title":"Existing","state":"OPEN","baseRefName":"main","headRefName":"feature"}]\n',
    });

    const result = createPullRequest(runner, createOptions());

    expect(result).toMatchObject({
      ok: false,
      code: "existing_pr",
      pr: { number: 17, base: "main", head: "feature" },
    });
    expect(runner.requests.some(({ args }) => args[0] === "push")).toBeFalse();
  });

  test("reports a recoverable partial success when creation fails after push", () => {
    const runner = preparedRunner()
      .respond("git", ["push", "-u", "origin", "HEAD:refs/heads/feature"])
      .respond(
        "gh",
        [
          "pr",
          "create",
          "--base",
          "main",
          "--head",
          "feature",
          "--title",
          "fix(web): improve form navigation",
          "--body-file",
          "-",
          "--label",
          "🎨 package:web",
        ],
        "",
        1,
        "API unavailable",
      );

    const result = createPullRequest(runner, createOptions());

    expect(result).toEqual({
      ok: false,
      code: "pr_create_failed",
      message: "The branch was pushed, but pull request creation failed.",
      pushed: true,
      remoteBranch: "origin/feature",
      stderr: "API unavailable",
    });
  });

  test("rejects an unconfirmed or invalid draft before repository inspection", () => {
    const runner = new FakeRunner();

    const unconfirmed = createPullRequest(runner, createOptions({ confirmed: false }));
    const placeholder = createPullRequest(
      runner,
      createOptions({ body: "TODO: describe this change" }),
    );

    expect(unconfirmed).toMatchObject({ ok: false, code: "confirmation_required" });
    expect(placeholder).toMatchObject({ ok: false, code: "invalid_body" });
    expect(runner.requests).toEqual([]);
  });
});

function requestKey(command: CommandRequest["command"], args: string[]): string {
  return JSON.stringify([command, args]);
}
