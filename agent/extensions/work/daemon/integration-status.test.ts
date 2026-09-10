import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "./process-runner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";
import { IntegrationStatusObserver } from "./integration-status.ts";
import { testGitEnvironment } from "../test-support/git-environment.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class TestGitRunner implements ProcessRunner {
  private readonly delegate = new LocalProcessRunner();
  readonly requests: ProcessRequest[] = [];
  /** Runs after each delegated command, so a test can move a Branch mid-calculation. */
  afterRequest: ((request: ProcessRequest) => Promise<void>) | undefined;

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    const result = await this.delegate.run({ ...request, env: testGitEnvironment(request.cwd) });
    await this.afterRequest?.(request);
    return result;
  }

  countOf(subcommand: string): number {
    return this.requests.filter((request) => request.args[0] === subcommand).length;
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: testGitEnvironment(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(repository: string, file: string, content: string): Promise<string> {
  await writeFile(join(repository, file), content, "utf8");
  await git(repository, "add", file);
  await git(repository, "commit", "-m", `${file}: ${content}`);
  return git(repository, "rev-parse", "HEAD");
}

/** A repository whose `main` Branch holds one commit and whose HEAD stays on `main`. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-status-"));
  roots.push(root);
  const path = join(root, "revault");
  await git(root, "init", "--initial-branch=main", path);
  await git(path, "config", "user.email", "agent@example.com");
  await git(path, "config", "user.name", "Agent");
  await commit(path, "base.txt", "base");
  return path;
}

/** `main` and `topic` share the first commit and then each add one commit. */
async function divergent(topicFile: string, mainFile: string): Promise<string> {
  const path = await repository();
  await git(path, "checkout", "-b", "topic");
  await commit(path, topicFile, "topic side");
  await git(path, "checkout", "main");
  await commit(path, mainFile, "main side");
  await git(path, "checkout", "topic");
  return path;
}

function observer(runner: ProcessRunner): IntegrationStatusObserver {
  return new IntegrationStatusObserver({ runner });
}

describe("local Integration Status", () => {
  test("reports Current when the Integration Target is an ancestor", async () => {
    const path = await repository();
    await git(path, "checkout", "-b", "topic");
    await commit(path, "topic.txt", "work");
    const runner = new TestGitRunner();

    const status = await observer(runner).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "current", ahead: 1, behind: 0, target: "main" });
  });

  test("reports Current when both Branches point at the same commit", async () => {
    const path = await repository();
    await git(path, "branch", "topic");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "current", ahead: 0, behind: 0, target: "main" });
  });

  test("reports Behind for a clean divergent edge", async () => {
    const path = await divergent("topic.txt", "main.txt");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "behind", ahead: 1, behind: 1, target: "main" });
  });

  test("reports Conflict for a divergent edge that Git predicts to conflict", async () => {
    const path = await divergent("shared.txt", "shared.txt");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "conflict", ahead: 1, behind: 1, target: "main" });
  });

  test("uncommitted Worktree changes do not change the status", async () => {
    const path = await divergent("topic.txt", "main.txt");
    await writeFile(join(path, "topic.txt"), "uncommitted work", "utf8");
    await writeFile(join(path, "untracked.txt"), "untracked", "utf8");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "behind", ahead: 1, behind: 1, target: "main" });
  });

  test("remote refs do not change the status", async () => {
    const path = await repository();
    await git(path, "checkout", "-b", "topic");
    await commit(path, "topic.txt", "work");
    await git(path, "checkout", "main");
    const remoteOnly = await commit(path, "topic.txt", "remote side");
    await git(path, "reset", "--hard", "HEAD~1");
    await git(path, "update-ref", "refs/remotes/origin/main", remoteOnly);
    await git(path, "checkout", "topic");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status).toEqual({ kind: "current", ahead: 1, behind: 0, target: "main" });
  });

  test("a missing local Branch is Unknown with a bounded detail", async () => {
    const path = await repository();

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "main",
      targetBranch: "release",
    });

    expect(status.kind).toBe("unknown");
    expect(status.target).toBe("release");
    expect(status.detail).toBe("A local Branch of this Integration Chain edge is missing.");
  });

  test("an invalid Branch name is Unknown and runs no Git command", async () => {
    const runner = new TestGitRunner();

    const status = await observer(runner).observe({
      repositoryPath: "/nowhere",
      branch: "topic",
      targetBranch: "--upload-pack=evil",
    });

    expect(status.kind).toBe("unknown");
    expect(runner.requests).toEqual([]);
  });

  test("unrelated histories are Unknown", async () => {
    const path = await repository();
    await git(path, "checkout", "--orphan", "topic");
    await git(path, "rm", "-rf", ".");
    await commit(path, "orphan.txt", "orphan");

    const status = await observer(new TestGitRunner()).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status.kind).toBe("unknown");
    expect(status.detail).toBe("The Topic and its Integration Target have unrelated histories.");
  });

  test("a command failure and a deadline are Unknown", async () => {
    const failing: ProcessRunner = { run: () => Promise.reject(new Error("no git")) };
    const timing: ProcessRunner = {
      run: () =>
        Promise.resolve({
          status: "timeout",
          exitCode: null,
          stdout: "",
          stderr: "",
          outputTruncated: false,
        }),
    };

    for (const runner of [failing, timing]) {
      const status = await observer(runner).observe({
        repositoryPath: "/nowhere",
        branch: "topic",
        targetBranch: "main",
      });
      expect(status.kind).toBe("unknown");
      expect(status.detail).toBe("A local Branch of this Integration Chain edge is missing.");
    }
  });

  test("truncated command output is not trusted", async () => {
    const runner: ProcessRunner = {
      run: () =>
        Promise.resolve({
          status: "completed",
          exitCode: 0,
          stdout: `${"a".repeat(40)}\n`,
          stderr: "",
          outputTruncated: true,
        }),
    };

    const status = await observer(runner).observe({
      repositoryPath: "/nowhere",
      branch: "topic",
      targetBranch: "main",
    });

    expect(status.kind).toBe("unknown");
  });

  test("every Git command is bounded and runs in a clean repository environment", async () => {
    const path = await divergent("shared.txt", "shared.txt");
    const runner = new TestGitRunner();

    await observer(runner).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(runner.requests.length).toBeGreaterThan(0);
    for (const request of runner.requests) {
      expect(request.command).toBe("git");
      expect(request.cwd).toBe(path);
      expect(request.timeoutMs).toBeGreaterThan(0);
      expect(request.maxOutputBytes).toBeGreaterThan(0);
      expect(request.unsetEnv).toEqual(GIT_LOCAL_ENVIRONMENT_VARIABLES);
    }
  });

  test("never creates a temporary Worktree and never changes repository state", async () => {
    const path = await divergent("shared.txt", "shared.txt");
    const runner = new TestGitRunner();
    const worktreesBefore = await git(path, "worktree", "list");

    await observer(runner).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    const forbidden = [
      "worktree",
      "clone",
      "fetch",
      "pull",
      "merge",
      "rebase",
      "reset",
      "cherry-pick",
      "checkout",
      "switch",
      "branch",
      "push",
      "update-ref",
    ];
    for (const request of runner.requests) {
      expect(forbidden).not.toContain(request.args[0] ?? "");
    }
    expect(await git(path, "worktree", "list")).toBe(worktreesBefore);
    expect(await git(path, "status", "--porcelain")).toBe("");
  });

  test("caches one resolved SHA pair and recalculates after a Branch moves", async () => {
    const path = await divergent("shared.txt", "shared.txt");
    const runner = new TestGitRunner();
    const status = observer(runner);
    const request = { repositoryPath: path, branch: "topic", targetBranch: "main" } as const;

    expect((await status.observe(request)).kind).toBe("conflict");
    expect(runner.countOf("rev-list")).toBe(1);
    expect(runner.countOf("merge-tree")).toBe(1);

    expect((await status.observe(request)).kind).toBe("conflict");
    expect(runner.countOf("rev-list")).toBe(1);
    expect(runner.countOf("merge-tree")).toBe(1);
    expect(status.cacheSize).toBe(1);

    await git(path, "checkout", "topic");
    await commit(path, "shared.txt", "main side");
    expect((await status.observe(request)).kind).toBe("behind");
    expect(runner.countOf("rev-list")).toBe(2);
    expect(status.cacheSize).toBe(2);
  });

  test("keeps the cache bounded", async () => {
    const path = await repository();
    await git(path, "checkout", "-b", "topic");
    const runner = new TestGitRunner();
    const status = new IntegrationStatusObserver({ runner, maxCacheEntries: 2 });

    for (let index = 0; index < 3; index += 1) {
      await commit(path, "topic.txt", `work ${index}`);
      expect(
        (await status.observe({ repositoryPath: path, branch: "topic", targetBranch: "main" }))
          .kind,
      ).toBe("current");
    }

    expect(status.cacheSize).toBe(2);
  });

  test("does not publish a result whose Branch tips moved during the calculation", async () => {
    const path = await divergent("topic.txt", "main.txt");
    const first = await git(path, "rev-parse", "refs/heads/topic");
    const second = await commit(path, "moved.txt", "moved");
    const runner = new TestGitRunner();
    let flip = 0;
    runner.afterRequest = async (request) => {
      if (request.args[0] !== "rev-list") return;
      flip += 1;
      await git(path, "update-ref", "refs/heads/topic", flip % 2 === 1 ? second : first);
    };
    await git(path, "update-ref", "refs/heads/topic", first);

    const status = await observer(runner).observe({
      repositoryPath: path,
      branch: "topic",
      targetBranch: "main",
    });

    expect(status.kind).toBe("unknown");
    expect(status.detail).toBe("Branch tips moved while Integration Status was calculated.");
  });
});
