import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testGitEnvironment } from "./git-environment.ts";

/**
 * Real local Git repositories for end-to-end Integration Chain tests: a Parent Branch with
 * named checkpoint commits, child Branches created at one checkpoint, real Worktrees, and
 * manual rebase steps. Every command runs in the isolated test Git environment, so no test
 * reads the user's Git configuration, credentials, or remotes.
 */

export interface TestGitRepositoryOptions {
  /** Branch of the first commit. Defaults to `main`. */
  initialBranch?: string;
}

/** One local Git repository under test, addressed by its checkout path. */
export class TestGitRepository {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /**
   * Creates one repository with a single commit on its initial Branch. The caller owns the
   * parent directory and removes it after the test.
   */
  static async create(
    parentDirectory: string,
    name: string,
    options: TestGitRepositoryOptions = {},
  ): Promise<TestGitRepository> {
    const path = join(parentDirectory, name);
    const initialBranch = options.initialBranch ?? "main";
    await runGit(parentDirectory, ["init", `--initial-branch=${initialBranch}`, path]);
    const repository = new TestGitRepository(path);
    await repository.git("config", "user.email", "agent@example.com");
    await repository.git("config", "user.name", "Agent");
    await repository.git("config", "commit.gpgsign", "false");
    await repository.commit("base.txt", "base");
    return repository;
  }

  /** Runs one Git command in the repository checkout and returns its trimmed stdout. */
  git(...args: string[]): Promise<string> {
    return runGit(this.path, args);
  }

  /** Writes one file and commits it on the currently checked-out Branch. */
  async commit(file: string, content: string, cwd = this.path): Promise<string> {
    await writeFile(join(cwd, file), `${content}\n`, "utf8");
    await runGit(cwd, ["add", "--", file]);
    await runGit(cwd, ["commit", "-m", `${file}: ${content}`]);
    return runGit(cwd, ["rev-parse", "HEAD"]);
  }

  /** Creates one Branch at an exact start point without checking it out. */
  async createBranch(branch: string, startPoint: string): Promise<void> {
    await this.git("branch", "--", branch, startPoint);
  }

  /** Checks one Branch out in the Base checkout. */
  async checkout(branch: string): Promise<void> {
    await this.git("checkout", branch);
  }

  /** Adds one real Worktree for an existing Branch and returns its path. */
  async addWorktree(worktreePath: string, branch: string): Promise<string> {
    await this.git("worktree", "add", worktreePath, branch);
    return worktreePath;
  }

  /** The committed tip of one local Branch. */
  tip(branch: string): Promise<string> {
    return this.git("rev-parse", "--verify", `refs/heads/${branch}^{commit}`);
  }

  /** The commits of one local Branch, newest first. */
  async history(branch: string): Promise<string[]> {
    const output = await this.git("rev-list", branch);
    return output.length === 0 ? [] : output.split("\n");
  }

  /** Runs the same plain rebase used by the dashboard action and by manual cascade repair. */
  async rebase(worktreePath: string, onto: string): Promise<void> {
    await runGit(worktreePath, ["rebase", onto]);
  }
}

export interface ParentBranchScenario {
  repository: TestGitRepository;
  /** Integration Branch of the repository, checked out in the Base checkout. */
  integrationBranch: string;
  /** Parent Branch that continues the Integration Branch. */
  parentBranch: string;
  /** Parent Branch checkpoint commits, oldest first. */
  checkpoints: string[];
}

export interface ParentBranchScenarioOptions {
  repositoryName?: string;
  integrationBranch?: string;
  parentBranch?: string;
  /** Number of commits added on the Parent Branch. Defaults to four. */
  checkpointCount?: number;
}

/**
 * A full Parent Branch scenario: one Integration Branch with a base commit and one Parent
 * Branch whose checkpoint commits are the Start Points of later child Topics.
 */
export async function createParentBranchScenario(
  parentDirectory: string,
  options: ParentBranchScenarioOptions = {},
): Promise<ParentBranchScenario> {
  const integrationBranch = options.integrationBranch ?? "main";
  const parentBranch = options.parentBranch ?? "feat-parent";
  const repository = await TestGitRepository.create(
    parentDirectory,
    options.repositoryName ?? "revault",
    { initialBranch: integrationBranch },
  );
  await repository.git("checkout", "-b", parentBranch);
  const checkpoints: string[] = [];
  for (let index = 1; index <= (options.checkpointCount ?? 4); index += 1) {
    checkpoints.push(await repository.commit(`parent-${index}.txt`, `parent step ${index}`));
  }
  await repository.checkout(integrationBranch);
  return { repository, integrationBranch, parentBranch, checkpoints };
}

/** Creates one checkpoint child Branch with its own real Worktree, as provisioning does. */
export async function createCheckpointChild(
  repository: TestGitRepository,
  input: { branch: string; startPoint: string; worktreePath: string },
): Promise<string> {
  await repository.createBranch(input.branch, input.startPoint);
  return repository.addWorktree(input.worktreePath, input.branch);
}

/** Creates one private temporary directory and returns its path. */
export function createTemporaryRoot(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Removes temporary directories created by a test, ignoring missing ones. */
export async function removeTemporaryRoots(roots: string[]): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
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
