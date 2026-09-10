import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalProcessRunner } from "../daemon/process-runner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../daemon/process-runner.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";
import {
  parseGitHubOrigin,
  resolveChildTopicCreationInput,
  resolveTopicCreationInput,
} from "./topic-creation.ts";
import { testGitEnvironment } from "../test-support/git-environment.ts";

class RecordingRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  private readonly local = new LocalProcessRunner();

  run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return this.local.run({ ...request, env: testGitEnvironment(request.cwd) });
  }
}

let temporaryDirectory = "";
let repository = "";
let commits: string[] = [];

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "work-topic-input-"));
  repository = join(temporaryDirectory, "source");
  await mkdir(repository);
  git(repository, "init", "-q");
  git(repository, "config", "user.name", "Test User");
  git(repository, "config", "user.email", "test@example.com");
  git(repository, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  for (const content of ["one", "two", "three"]) {
    await Bun.write(join(repository, "item.txt"), content);
    git(repository, "add", "item.txt");
    git(repository, "commit", "-qm", content);
    commits.push(git(repository, "rev-parse", "HEAD"));
  }
  git(repository, "tag", "-a", "release", "-m", "Release", commits[0]!);
});

afterEach(async () => {
  commits = [];
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("Topic creation defaults", () => {
  test("keeps the dashboard Branch rule in the shared module", () => {
    expect(defaultBranchForTopicName("My contribution")).toBe("my-contribution");
    expect(defaultBranchForTopicName("vg-123 Fix Été")).toBe("VG-123-fix-ete");
    expect(defaultBranchForTopicName(" : / .. ")).toBe("");
  });

  test("preserves a valid explicit Branch and needs no checkout", async () => {
    await expect(
      resolveTopicCreationInput({
        name: "  My contribution  ",
        repository: "acme/widgets",
        branch: " Feature/Keep-Case ",
      }),
    ).resolves.toEqual({
      name: "My contribution",
      repository: "acme/widgets",
      branch: "Feature/Keep-Case",
    });
  });

  test("rejects invalid explicit and generated Branches", async () => {
    await expect(
      resolveTopicCreationInput({ name: "Topic", repository: "acme/widgets", branch: "bad..ref" }),
    ).rejects.toMatchObject({ code: "invalid-branch" });
    await expect(
      resolveTopicCreationInput({ name: " : / .. ", repository: "acme/widgets" }),
    ).rejects.toMatchObject({ code: "invalid-branch" });
  });
});

describe("GitHub origin resolution", () => {
  test("parses HTTPS and SSH origin forms", () => {
    expect(parseGitHubOrigin("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(parseGitHubOrigin("git@github.com:acme/widgets.git")).toBe("acme/widgets");
    expect(parseGitHubOrigin("ssh://git@github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(() => parseGitHubOrigin("https://example.com/acme/widgets.git")).toThrow();
  });

  test("infers the repository and canonical worktree root from a child directory", async () => {
    const child = join(repository, "nested");
    await mkdir(child);
    const runner = new RecordingRunner();
    const result = await resolveTopicCreationInput(
      { name: "My contribution", sourceCheckout: child },
      { runner },
    );

    expect(result).toEqual({
      name: "My contribution",
      repository: "acme/widgets",
      branch: "my-contribution",
    });
    expect(runner.requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["remote", "get-url", "origin"],
    ]);
    expect(runner.requests.every((request) => request.command === "git")).toBe(true);
  });

  test("rejects a supplied repository that differs from the Start Point checkout", async () => {
    await expect(
      resolveTopicCreationInput({
        name: "Mismatch",
        repository: "other/widgets",
        startPoint: "HEAD",
        sourceCheckout: repository,
      }),
    ).rejects.toMatchObject({ code: "repository-mismatch" });
  });
});

describe("Start Point resolution", () => {
  test.each([
    ["relative revision", "HEAD~2", () => commits[0]],
    ["short SHA", () => commits[1]!.slice(0, 9), () => commits[1]],
    ["annotated tag", "release", () => commits[0]],
  ])("peels a %s to one full commit", async (_label, revisionValue, expected) => {
    const revision = typeof revisionValue === "function" ? revisionValue() : revisionValue;
    const result = await resolveTopicCreationInput({
      name: "Selected commit",
      startPoint: revision,
      sourceCheckout: repository,
    });

    expect(result.startPoint).toEqual({
      commit: expected()!,
      sourceCheckout: repository,
    });
  });

  test.each(["tree", "blob", "missing", "ambiguous"])(
    "rejects a %s revision with a bounded diagnostic",
    async (kind) => {
      let revision = "does-not-exist";
      if (kind === "tree") revision = "HEAD^{tree}";
      if (kind === "blob") revision = "HEAD:item.txt";
      if (kind === "ambiguous") {
        git(repository, "branch", "collision", commits[0]!);
        git(repository, "tag", "collision", commits[1]!);
        revision = "collision";
      }

      try {
        await resolveTopicCreationInput({
          name: "Bad commit",
          startPoint: revision,
          sourceCheckout: repository,
        });
        throw new Error("Expected resolution to fail.");
      } catch (error) {
        expect(error).toMatchObject({ code: "git-resolution-failed" });
        expect((error as Error).message.length).toBeLessThanOrEqual(200);
      }
    },
  );

  test("bounds output and time for every injected Git process", async () => {
    const runner = new RecordingRunner();
    await resolveTopicCreationInput(
      { name: "Bounded", startPoint: "HEAD", sourceCheckout: repository },
      { runner },
    );
    expect(runner.requests.length).toBe(3);
    expect(runner.requests.every((request) => request.timeoutMs === 10_000)).toBe(true);
    expect(runner.requests.every((request) => request.maxOutputBytes === 16 * 1024)).toBe(true);
  });
});

describe("Child Topic input resolution", () => {
  const parentTopicId = "11111111-2222-4333-8444-555555555555";

  test("takes the Parent Topic from the Main Agent session and derives the Branch", async () => {
    await expect(
      resolveChildTopicCreationInput(
        { name: "  Widen the note column  ", startPoint: "HEAD~1", sourceCheckout: repository },
        { environment: { PI_WORK_TOPIC_ID: parentTopicId } },
      ),
    ).resolves.toEqual({
      parentTopicId,
      name: "Widen the note column",
      branch: "widen-the-note-column",
      startPoint: { commit: commits[1]!, sourceCheckout: repository },
    });
  });

  test("prefers an explicit Parent Topic and keeps an explicit Branch and SHA", async () => {
    await expect(
      resolveChildTopicCreationInput(
        {
          name: "Second commit",
          parentTopicId,
          branch: "Feature/Keep-Case",
          startPoint: commits[1]!,
          sourceCheckout: repository,
        },
        { environment: { PI_WORK_TOPIC_ID: "99999999-2222-4333-8444-555555555555" } },
      ),
    ).resolves.toMatchObject({
      parentTopicId,
      branch: "Feature/Keep-Case",
      startPoint: { commit: commits[1]!, sourceCheckout: repository },
    });
  });

  test("rejects a missing or invalid Parent Topic without contacting Git", async () => {
    const runner = new RecordingRunner();
    await expect(
      resolveChildTopicCreationInput(
        { name: "Orphan", startPoint: "HEAD", sourceCheckout: repository },
        { environment: {}, runner },
      ),
    ).rejects.toMatchObject({ code: "parent-topic-required" });
    await expect(
      resolveChildTopicCreationInput(
        {
          name: "Orphan",
          parentTopicId: "not-a-topic",
          startPoint: "HEAD",
          sourceCheckout: repository,
        },
        { environment: {}, runner },
      ),
    ).rejects.toMatchObject({ code: "invalid-parent-topic" });
    expect(runner.requests).toHaveLength(0);
  });

  test("requires a non-empty Start Point and a Source checkout", async () => {
    await expect(
      resolveChildTopicCreationInput(
        { name: "Child", startPoint: "  ", sourceCheckout: repository },
        { environment: { PI_WORK_TOPIC_ID: parentTopicId } },
      ),
    ).rejects.toMatchObject({ code: "invalid-start-point" });
    await expect(
      resolveChildTopicCreationInput(
        { name: "Child", startPoint: "HEAD" },
        { environment: { PI_WORK_TOPIC_ID: parentTopicId } },
      ),
    ).rejects.toMatchObject({ code: "source-checkout-required" });
  });

  test("applies the same bounded Git safety rules as normal creation", async () => {
    const runner = new RecordingRunner();
    await resolveChildTopicCreationInput(
      { name: "Bounded child", startPoint: "HEAD", sourceCheckout: repository },
      { environment: { PI_WORK_TOPIC_ID: parentTopicId }, runner },
    );
    expect(runner.requests.map((request) => request.args)).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"],
    ]);
    expect(runner.requests.every((request) => request.timeoutMs === 10_000)).toBe(true);
    expect(runner.requests.every((request) => request.maxOutputBytes === 16 * 1024)).toBe(true);

    await expect(
      resolveChildTopicCreationInput(
        { name: "Bad child", startPoint: "HEAD^{tree}", sourceCheckout: repository },
        { environment: { PI_WORK_TOPIC_ID: parentTopicId } },
      ),
    ).rejects.toMatchObject({ code: "git-resolution-failed" });
  });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: testGitEnvironment(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
