import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_IDS, createConfigStore, createWorkPaths } from "../shared/index.ts";
import type { ConfigStore, WorkConfig } from "../shared/index.ts";
import { LocalProcessRunner } from "./process-runner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";
import { IntegrationBranchResolver } from "./integration-branch.ts";
import { testGitEnvironment } from "../test-support/git-environment.ts";

const REPOSITORY = "LedgerHQ/revault";
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

function baseConfig(basePath: string): WorkConfig {
  return {
    version: 1,
    workBase: join(basePath, "..", "work-base"),
    policies: {
      defaults: Object.fromEntries(ACTION_IDS.map((action) => [action, "allow"])),
      repositories: {},
      topics: {},
    },
    repositories: { [REPOSITORY]: { setupCommands: [], basePath } },
  };
}

interface TestWorld {
  base: string;
  config: ConfigStore;
  runner: TestGitRunner;
  resolver: IntegrationBranchResolver;
}

async function world(initialBranch = "main"): Promise<TestWorld> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-integration-"));
  roots.push(root);
  const base = join(root, "revault");
  await git(root, "init", `--initial-branch=${initialBranch}`, base);
  await git(base, "config", "user.email", "agent@example.com");
  await git(base, "config", "user.name", "Agent");
  await git(base, "commit", "--allow-empty", "-m", "first");
  const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
  const config = createConfigStore(paths);
  await config.save(baseConfig(base));
  const runner = new TestGitRunner();
  return { base, config, runner, resolver: new IntegrationBranchResolver({ config, runner }) };
}

describe("Integration Branch inference", () => {
  test("infers and persists the Branch checked out in the Base checkout", async () => {
    const { config, resolver } = await world("main");

    expect(await resolver.ensure(REPOSITORY)).toBe("main");
    expect((await config.load())?.repositories[REPOSITORY]?.integrationBranch).toBe("main");
  });

  test("infers master when the Base checkout uses it", async () => {
    const { resolver } = await world("master");

    expect(await resolver.ensure(REPOSITORY)).toBe("master");
  });

  test("uses local symbolic origin/HEAD for a detached Base checkout", async () => {
    const { base, resolver } = await world("trunk");
    await git(
      base,
      "update-ref",
      "refs/remotes/origin/trunk",
      await git(base, "rev-parse", "HEAD"),
    );
    await git(base, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    await git(base, "checkout", "--detach", "HEAD");

    expect(await resolver.ensure(REPOSITORY)).toBe("trunk");
  });

  test("falls back to local main for a detached Base checkout without origin/HEAD", async () => {
    const { base, resolver } = await world("main");
    await git(base, "checkout", "--detach", "HEAD");

    expect(await resolver.ensure(REPOSITORY)).toBe("main");
  });

  test("falls back to local master when only master exists", async () => {
    const { base, resolver } = await world("master");
    await git(base, "checkout", "--detach", "HEAD");

    expect(await resolver.ensure(REPOSITORY)).toBe("master");
  });

  test("stores nothing when no valid local candidate exists", async () => {
    const { base, config, resolver } = await world("trunk");
    await git(base, "checkout", "--detach", "HEAD");
    await git(base, "branch", "--delete", "trunk");

    expect(await resolver.ensure(REPOSITORY)).toBeUndefined();
    expect((await config.load())?.repositories[REPOSITORY]?.integrationBranch).toBeUndefined();
  });

  test("keeps the persisted Branch after the Base checkout switches Branches", async () => {
    const { base, resolver, runner } = await world("main");
    expect(await resolver.ensure(REPOSITORY)).toBe("main");
    await git(base, "checkout", "-b", "feat/other");
    const requestsAfterFirst = runner.requests.length;

    expect(await resolver.ensure(REPOSITORY)).toBe("main");
    expect(runner.requests.length).toBe(requestsAfterFirst);
  });

  test("never runs a Git command that changes repository state", async () => {
    const { resolver, runner } = await world("main");
    await resolver.ensure(REPOSITORY);

    const mutating = ["fetch", "pull", "merge", "rebase", "reset", "cherry-pick", "branch", "push"];
    for (const request of runner.requests) {
      expect(request.command).toBe("git");
      expect(mutating).not.toContain(request.args[0] ?? "");
    }
  });

  test("returns undefined without configuration and without a Base checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-work-integration-"));
    roots.push(root);
    const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
    const config = createConfigStore(paths);
    const resolver = new IntegrationBranchResolver({ config, runner: new TestGitRunner() });

    expect(await resolver.ensure(REPOSITORY)).toBeUndefined();

    await config.save({
      version: 1,
      policies: {
        defaults: Object.fromEntries(ACTION_IDS.map((action) => [action, "allow"])),
        repositories: {},
        topics: {},
      },
      repositories: {},
    });
    expect(await resolver.ensure(REPOSITORY)).toBeUndefined();
  });

  test("ensureAll ignores repositories without a usable Base checkout", async () => {
    const { config, resolver } = await world("main");

    await resolver.ensureAll([REPOSITORY, "LedgerHQ/missing", REPOSITORY]);

    const loaded = await config.load();
    expect(loaded?.repositories[REPOSITORY]?.integrationBranch).toBe("main");
    expect(loaded?.repositories["LedgerHQ/missing"]).toBeUndefined();
  });
});
