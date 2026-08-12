import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTION_IDS, createTopicStore, createWorkPaths } from "../shared/index.ts";
import type { ActionId, TopicStore, WorkPolicies } from "../shared/index.ts";
import { TopicProvisioner, normalizeGitHubRemote, parseWtPath } from "./provisioner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const roots: string[] = [];

interface TestWorld {
  root: string;
  workBase: string;
  base: string;
  worktree: string;
  topics: TopicStore;
  runner: FakeRunner;
  provisioner: TopicProvisioner;
}

class FakeRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  origin = "git@github.com:LedgerHQ/revault.git";
  base = "";
  worktree = "";
  branch = "feat-test";
  branchExists = false;
  listedWorktree = false;
  cloneResult: ProcessResult | undefined = undefined;
  wtResult: ProcessResult | undefined = undefined;
  onClone: (() => Promise<void>) | undefined = undefined;
  onWt: (() => Promise<void>) | undefined = undefined;

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.command === "gh") {
      await this.onClone?.();
      return this.cloneResult ?? complete();
    }
    if (request.command === "wt") {
      await this.onWt?.();
      return this.wtResult ?? complete(JSON.stringify({ action: "created", path: this.worktree }));
    }
    const args = request.args.join(" ");
    if (args === "rev-parse --show-toplevel") return complete(request.cwd);
    if (args === "rev-parse --git-common-dir") return complete(join(this.base, ".git"));
    if (args === "remote get-url origin") return complete(this.origin);
    if (args === "symbolic-ref --short HEAD") return complete(this.branch);
    if (args === `show-ref --verify --quiet refs/heads/${this.branch}`) {
      return complete("", this.branchExists ? 0 : 1);
    }
    if (args === "worktree list --porcelain -z") {
      const records = [`worktree ${this.base}\0branch refs/heads/main\0\0`];
      if (this.listedWorktree) {
        records.push(`worktree ${this.worktree}\0branch refs/heads/${this.branch}\0\0`);
      }
      return complete(records.join(""));
    }
    throw new Error(`Unexpected process request: ${request.command} ${args}`);
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function world(
  options: { repositoryExists?: boolean; branch?: string; worktreeName?: string } = {},
): Promise<TestWorld> {
  const root = await mkdtemp(join(tmpdir(), "work-provisioner-test-"));
  roots.push(root);
  const workBase = join(root, "ledger");
  const base = join(workBase, "revault");
  const branch = options.branch ?? "feat-test";
  const worktree =
    options.worktreeName === undefined
      ? join(root, "wt-owned", "revault.feat-test")
      : join(workBase, options.worktreeName);
  await mkdir(workBase, { recursive: true });
  if (options.repositoryExists !== false) await mkdir(join(base, ".git"), { recursive: true });
  const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
  const topics = createTopicStore(paths, { generateId: () => ID });
  await topics.create({ name: "Test", branch, repository: "LedgerHQ/revault" });
  const runner = new FakeRunner();
  runner.base = base;
  runner.worktree = worktree;
  runner.branch = branch;
  runner.onClone = async () => {
    await mkdir(join(base, ".git"), { recursive: true });
  };
  runner.onWt = async () => {
    await mkdir(worktree, { recursive: true });
    runner.branchExists = true;
    runner.listedWorktree = true;
  };
  return {
    root,
    workBase,
    base,
    worktree,
    topics,
    runner,
    provisioner: new TopicProvisioner({ topics, runner }),
  };
}

function policies(
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
): WorkPolicies {
  return {
    defaults: Object.fromEntries(
      ACTION_IDS.map((action) => [action, overrides[action] ?? "allow"]),
    ),
    repositories: {},
    topics: {},
  };
}

function complete(stdout = "", exitCode = 0): ProcessResult {
  return {
    status: "completed",
    exitCode,
    stdout,
    stderr: "",
    outputTruncated: false,
  };
}

async function provision(item: TestWorld, policy = policies(), approvedActions?: Set<ActionId>) {
  return item.provisioner.provision({
    topicId: ID,
    workBase: item.workBase,
    policies: policy,
    ...(approvedActions === undefined ? {} : { approvedActions }),
  });
}

describe("GitHub remote and wt output parsing", () => {
  test("normalizes common SSH and HTTPS GitHub origins", () => {
    expect(normalizeGitHubRemote("git@github.com:LedgerHQ/revault.git\n")).toBe("ledgerhq/revault");
    expect(normalizeGitHubRemote("ssh://git@github.com/LedgerHQ/revault")).toBe("ledgerhq/revault");
    expect(normalizeGitHubRemote("https://github.com/LedgerHQ/revault.git/")).toBe(
      "ledgerhq/revault",
    );
    expect(normalizeGitHubRemote("https://example.com/LedgerHQ/revault")).toBeUndefined();
  });

  test("accepts supported absolute wt JSON shapes only", () => {
    expect(parseWtPath('{"path":"/tmp/topic"}')).toBe("/tmp/topic");
    expect(parseWtPath('{"worktree_path":"/tmp/topic"}')).toBe("/tmp/topic");
    expect(parseWtPath('{"worktree":{"path":"/tmp/topic"}}')).toBe("/tmp/topic");
    expect(parseWtPath('{"path":"relative"}')).toBeUndefined();
    expect(parseWtPath("not-json")).toBeUndefined();
  });
});

describe("repository provisioning", () => {
  test("accepts existing matching SSH and HTTPS origins", async () => {
    for (const origin of [
      "git@github.com:LedgerHQ/revault.git",
      "https://github.com/ledgerhq/revault",
    ]) {
      const item = await world();
      item.runner.origin = origin;
      expect((await provision(item)).status).toBe("ready");
      expect(item.runner.requests.some((request) => request.command === "gh")).toBeFalse();
    }
  });

  test("rejects a conflicting origin and a non-Git target without overwrite", async () => {
    const conflict = await world();
    conflict.runner.origin = "git@github.com:other/repo.git";
    const conflictResult = await provision(conflict);
    expect(conflictResult.status).toBe("failed");
    expect((await conflict.topics.load(ID)).setup.reason).toContain("another repository");

    const nonGit = await world({ repositoryExists: false });
    await writeFile(nonGit.base, "occupied");
    const nonGitResult = await provision(nonGit);
    expect(nonGitResult.status).toBe("failed");
    expect(nonGit.runner.requests).toHaveLength(0);
  });

  test("clones a missing repository with exact argument arrays and bounded execution", async () => {
    const item = await world({ repositoryExists: false });
    expect((await provision(item)).status).toBe("ready");
    const clone = item.runner.requests.find((request) => request.command === "gh");
    expect(clone).toMatchObject({
      args: ["repo", "clone", "LedgerHQ/revault", item.base],
      cwd: item.workBase,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });
  });

  test("returns explicit clone failure and timeout results", async () => {
    const failed = await world({ repositoryExists: false });
    failed.runner.onClone = undefined;
    failed.runner.cloneResult = { ...complete("", 1), stderr: "not found" };
    const failedResult = await provision(failed);
    expect(failedResult.status).toBe("failed");
    if (failedResult.status === "failed") {
      expect(failedResult.reason).toBe("Repository clone failed with exit code 1.");
      expect(failedResult.reason).not.toContain("not found");
    }

    const timedOut = await world({ repositoryExists: false });
    timedOut.runner.onClone = undefined;
    timedOut.runner.cloneResult = {
      status: "timeout",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
    expect(await provision(timedOut)).toMatchObject({ status: "timeout" });
    expect((await timedOut.topics.load(ID)).setup.state).toBe("setup-failed");
  });

  test("returns an explicit cancellation result without starting a process", async () => {
    const item = await world({ repositoryExists: false });
    const controller = new AbortController();
    controller.abort();
    const result = await item.provisioner.provision({
      topicId: ID,
      workBase: item.workBase,
      policies: policies(),
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(item.runner.requests).toHaveLength(0);
    expect((await item.topics.load(ID)).setup.state).toBe("setup-failed");
  });
});

describe("wt provisioning and durable recovery", () => {
  test("stores the wt-owned path and durable ready checkpoints", async () => {
    const item = await world();
    const result = await provision(item);
    expect(result.status).toBe("ready");
    expect(await item.topics.load(ID)).toMatchObject({
      setup: { state: "ready", repositoryAvailable: true, worktreeCreated: true },
      worktreePath: item.worktree,
    });
    const wt = item.runner.requests.find((request) => request.command === "wt");
    expect(wt?.args).toEqual(["switch", "--create", "feat-test", "--format", "json"]);
    expect(wt?.cwd).toBe(item.base);
  });

  test("passes a slash Branch unchanged and stores the path returned by wt", async () => {
    const item = await world({
      branch: "feat/VG-31025_tokenization",
      worktreeName: "revault.feat-VG-31025_tokenization",
    });

    expect((await provision(item)).status).toBe("ready");
    const wt = item.runner.requests.find((request) => request.command === "wt");
    expect(wt?.args).toEqual([
      "switch",
      "--create",
      "feat/VG-31025_tokenization",
      "--format",
      "json",
    ]);
    expect((await item.topics.load(ID)).worktreePath).toBe(
      join(item.workBase, "revault.feat-VG-31025_tokenization"),
    );
  });

  test("rejects invalid, relative, missing, and oversized wt output", async () => {
    const cases: string[] = [
      "not-json",
      '{"path":"relative"}',
      '{"path":"/missing/topic"}',
      `{"path":"/${"x".repeat(70_000)}"}`,
    ];
    for (const output of cases) {
      const item = await world();
      item.runner.onWt = undefined;
      item.runner.wtResult = complete(output);
      expect((await provision(item)).status).toBe("failed");
      expect((await item.topics.load(ID)).setup.state).toBe("setup-failed");
    }
  });

  test("retries after clone succeeded but wt failed without cloning again", async () => {
    const item = await world({ repositoryExists: false });
    item.runner.onWt = undefined;
    item.runner.wtResult = { ...complete("", 1), stderr: "wt failed" };
    expect((await provision(item)).status).toBe("failed");
    item.runner.wtResult = undefined;
    item.runner.onWt = async () => {
      await mkdir(item.worktree, { recursive: true });
      item.runner.listedWorktree = true;
    };
    expect((await provision(item)).status).toBe("ready");
    expect(item.runner.requests.filter((request) => request.command === "gh")).toHaveLength(1);
  });

  test("recovers an existing worktree after an interrupted wt response", async () => {
    const item = await world();
    item.runner.wtResult = { ...complete("", 1), stderr: "connection lost" };
    expect((await provision(item)).status).toBe("ready");
    expect((await item.topics.load(ID)).worktreePath).toBe(item.worktree);
  });

  test("uses wt to recover an existing branch without --create", async () => {
    const item = await world();
    item.runner.branchExists = true;
    expect((await provision(item)).status).toBe("ready");
    const wt = item.runner.requests.find((request) => request.command === "wt");
    expect(wt?.args).toEqual(["switch", "feat-test", "--format", "json"]);
  });
});

describe("provisioning action policies", () => {
  test("returns deny, ask, and approved ask outcomes immediately before mutation", async () => {
    const denied = await world({ repositoryExists: false });
    expect(await provision(denied, policies({ "repository.clone": "deny" }))).toMatchObject({
      status: "denied",
      action: "repository.clone",
    });
    expect(denied.runner.requests).toHaveLength(0);

    const asked = await world({ repositoryExists: false });
    expect(await provision(asked, policies({ "repository.clone": "ask" }))).toMatchObject({
      status: "confirmation-required",
      action: "repository.clone",
    });
    expect(asked.runner.requests).toHaveLength(0);

    const allowed = await world({ repositoryExists: false });
    expect(
      await provision(
        allowed,
        policies({ "repository.clone": "ask", "topic.create-worktree": "ask" }),
        new Set(["repository.clone", "topic.create-worktree"]),
      ),
    ).toMatchObject({ status: "ready" });
  });
});
