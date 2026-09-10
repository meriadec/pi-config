import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BranchAncestryReader } from "./branch-ancestry.ts";
import { GIT_LOCAL_ENVIRONMENT_VARIABLES, LocalProcessRunner } from "./process-runner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";
import { testGitEnvironment } from "../test-support/git-environment.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class TestGitRunner implements ProcessRunner {
  private readonly delegate = new LocalProcessRunner();
  readonly requests: ProcessRequest[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.delegate.run({ ...request, env: testGitEnvironment(request.cwd) });
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

async function commit(repository: string, file: string): Promise<string> {
  await writeFile(join(repository, file), file, "utf8");
  await git(repository, "add", file);
  await git(repository, "commit", "-m", file);
  return git(repository, "rev-parse", "HEAD");
}

/** `main` holds two commits; `early` stops at the first and `late` holds both. */
async function repository(): Promise<{ path: string; first: string; second: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-ancestry-"));
  roots.push(root);
  const path = join(root, "revault");
  await git(root, "init", "--initial-branch=main", path);
  await git(path, "config", "user.email", "agent@example.com");
  await git(path, "config", "user.name", "Agent");
  const first = await commit(path, "one.txt");
  const second = await commit(path, "two.txt");
  await git(path, "branch", "early", first);
  await git(path, "branch", "late", second);
  return { path, first, second };
}

describe("Branch ancestry", () => {
  test("answers committed Branch and commit ancestry in both directions", async () => {
    const { path, first } = await repository();
    const runner = new TestGitRunner();
    const reader = new BranchAncestryReader({ runner });

    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { branch: "early" },
        descendant: { branch: "late" },
      }),
    ).resolves.toBeTrue();
    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { branch: "late" },
        descendant: { branch: "early" },
      }),
    ).resolves.toBeFalse();
    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { commit: first },
        descendant: { branch: "main" },
      }),
    ).resolves.toBeTrue();
    // Every question is one bounded read-only command in a clean repository-local environment.
    expect(runner.requests).toHaveLength(3);
    for (const request of runner.requests) {
      expect(request.command).toBe("git");
      expect(request.args[0]).toBe("merge-base");
      expect(request.args[1]).toBe("--is-ancestor");
      expect(request.unsetEnv).toEqual(GIT_LOCAL_ENVIRONMENT_VARIABLES);
      expect(request.timeoutMs).toBeGreaterThan(0);
    }
  });

  test("gives no answer for a missing Branch, an unusable reference, or a failed command", async () => {
    const { path } = await repository();
    const reader = new BranchAncestryReader({ runner: new TestGitRunner() });

    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { branch: "early" },
        descendant: { branch: "absent" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { branch: "--upload-pack=evil" },
        descendant: { branch: "main" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      reader.contains({
        repositoryPath: path,
        ancestor: { commit: "not-a-sha" },
        descendant: { branch: "main" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      reader.contains({
        repositoryPath: join(path, "missing"),
        ancestor: { branch: "early" },
        descendant: { branch: "main" },
      }),
    ).resolves.toBeUndefined();
  });
});
