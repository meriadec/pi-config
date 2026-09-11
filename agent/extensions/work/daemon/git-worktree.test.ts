import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RecordingProcessRunner,
  TestGitRepository,
  createTemporaryRoot,
  removeTemporaryRoots,
} from "../test-support/git-repository.ts";
import { LocalGitWorktreeController } from "./git-worktree.ts";

const roots: string[] = [];

afterEach(async () => removeTemporaryRoots(roots));

async function divergent(changesSameFile = false): Promise<{
  repository: TestGitRepository;
  worktree: string;
}> {
  const root = await createTemporaryRoot("pi-work-rebase-");
  roots.push(root);
  const repository = await TestGitRepository.create(root, "repo");
  await repository.createBranch("topic", "main");
  const worktree = await repository.addWorktree(join(root, "topic-worktree"), "topic");
  await repository.commit(changesSameFile ? "base.txt" : "topic.txt", "topic", worktree);
  await repository.commit(changesSameFile ? "base.txt" : "main.txt", "main");
  return { repository, worktree };
}

describe("local Git Worktree control", () => {
  test("observes cleanliness, the checked-out Branch, and ignored files", async () => {
    const { repository, worktree } = await divergent();
    await writeFile(join(worktree, ".gitignore"), "ignored.txt\n", "utf8");
    await repository.git("-C", worktree, "add", ".gitignore");
    await repository.git("-C", worktree, "commit", "-m", "ignore generated file");
    await writeFile(join(worktree, "ignored.txt"), "ignored\n", "utf8");
    const controller = new LocalGitWorktreeController();

    expect(await controller.inspect(worktree)).toEqual({
      checkedOutBranch: "topic",
      clean: true,
    });

    await writeFile(join(worktree, "untracked.txt"), "untracked\n", "utf8");
    expect(await controller.inspect(worktree)).toMatchObject({ clean: false });
  });

  test("rebases a clean divergent Branch onto its local Integration Target", async () => {
    const { repository, worktree } = await divergent();
    const runner = new RecordingProcessRunner();
    const controller = new LocalGitWorktreeController({ runner });

    expect(await controller.rebase(worktree, "main")).toEqual({ status: "rebased" });
    expect(await repository.git("merge-base", "--is-ancestor", "main", "topic")).toBe("");
    const request = runner.requests.find((item) => item.args[0] === "rebase");
    expect(request).toMatchObject({
      command: "git",
      args: ["rebase", "main"],
      cwd: worktree,
      timeoutMs: 600_000,
    });
    expect(request?.env).toMatchObject({ GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" });
  });

  test("leaves a conflicting rebase in progress and reports it as a conflict", async () => {
    const { worktree } = await divergent(true);
    const controller = new LocalGitWorktreeController();

    const result = await controller.rebase(worktree, "main");

    expect(result.status).toBe("failed");
    expect(await controller.inspectOperation(worktree)).toEqual({
      kind: "rebase",
      conflict: true,
    });
  });

  test("detects other in-progress Git operations without changing them", async () => {
    const { repository, worktree } = await divergent();
    const controller = new LocalGitWorktreeController();
    const gitDirectory = await repository.git("-C", worktree, "rev-parse", "--absolute-git-dir");

    for (const [marker, kind] of [
      ["MERGE_HEAD", "merge"],
      ["CHERRY_PICK_HEAD", "cherry-pick"],
      ["REVERT_HEAD", "revert"],
    ] as const) {
      const path = join(gitDirectory, marker);
      await writeFile(path, `${"a".repeat(40)}\n`, "utf8");
      expect(await controller.inspectOperation(worktree)).toEqual({ kind, conflict: false });
      await rm(path);
    }
  });
});
