import { afterEach, describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAbsolutePath,
  decodeBranch,
  decodeFullCommitSha,
  decodeRepository,
} from "../../domain/index.ts";
import { makeProcessExecutor, ProcessPlatformLive } from "../process/index.ts";
import {
  createParentBranchScenario,
  createTemporaryRoot,
  removeTemporaryRoots,
  TestGitRepository,
} from "../../test-support/git-repository.ts";
import { makeGitControl } from "./git-control.ts";

const roots: string[] = [];
const pathOf = decodeAbsolutePath;
const branchOf = decodeBranch;
const shaOf = decodeFullCommitSha;
const repositoryOf = decodeRepository;

function run<A>(effect: Effect.Effect<A, unknown, any>): Promise<A> {
  const runnable = Effect.scoped(effect).pipe(Effect.provide(ProcessPlatformLive)) as Effect.Effect<
    A,
    unknown,
    never
  >;
  return Effect.runPromise(runnable);
}

afterEach(async () => removeTemporaryRoots(roots));

async function repository(): Promise<TestGitRepository> {
  const root = await createTemporaryRoot("pi-work-git-control-");
  roots.push(root);
  const repository = await TestGitRepository.create(root, "repo");
  await repository.git("remote", "add", "origin", "git@github.com:LedgerHQ/revault.git");
  return repository;
}

describe("deep Git control", () => {
  test("resolves repository identity and one exact Start Point", async () => {
    const repo = await repository();
    const control = makeGitControl(makeProcessExecutor());
    const resolved = await run(
      control.resolveStartPoint({
        sourceCheckout: pathOf(repo.path),
        revision: "HEAD",
        expectedRepository: repositoryOf("LedgerHQ/revault"),
      }),
    );

    expect(String(resolved.repository)).toBe("LedgerHQ/revault");
    expect(String(resolved.repositoryRoot)).toBe(repo.path);
    expect(String(resolved.startPoint.commit)).toBe(await repo.tip("main"));
    expect(String(resolved.startPoint.sourceCheckout)).toBe(repo.path);
  });

  test("reads exact tips and ancestry and creates a Branch at an exact commit", async () => {
    const repo = await repository();
    const base = shaOf(await repo.tip("main"));
    const control = makeGitControl(makeProcessExecutor());
    await run(control.createBranch(pathOf(repo.path), branchOf("topic"), base));
    const tip = await run(control.readBranchTip(pathOf(repo.path), branchOf("topic")));
    const contains = await run(
      control.contains(pathOf(repo.path), { commit: base }, { branch: branchOf("topic") }),
    );

    expect(tip).toBe(base);
    expect(contains).toBe(true);
  });

  test("lists, validates, and inspects a real Worktree without changing it", async () => {
    const repo = await repository();
    const base = await repo.tip("main");
    await repo.createBranch("topic", base);
    const worktree = join(repo.path, "topic-worktree");
    await repo.addWorktree(worktree, "topic");
    const control = makeGitControl(makeProcessExecutor());

    const listed = await run(control.listWorktrees(pathOf(repo.path)));
    const validated = await run(
      control.validateWorktree({
        repositoryPath: pathOf(repo.path),
        worktreePath: pathOf(worktree),
        repository: repositoryOf("LedgerHQ/revault"),
        branch: branchOf("topic"),
        commit: shaOf(base),
      }),
    );
    const clean = await run(control.inspectWorktree(pathOf(worktree)));
    await writeFile(join(worktree, "untracked.txt"), "local\n", "utf8");
    const dirty = await run(control.inspectWorktree(pathOf(worktree)));

    expect(listed.map((item) => String(item.path))).toContain(worktree);
    expect(String(validated.branch)).toBe("topic");
    expect(clean).toMatchObject({ clean: true, checkedOutBranch: "topic" });
    expect(dirty.clean).toBe(false);
  });

  test("calculates committed Integration Status and predicts conflicts", async () => {
    const root = await createTemporaryRoot("pi-work-git-status-");
    roots.push(root);
    const scenario = await createParentBranchScenario(root, { checkpointCount: 1 });
    await scenario.repository.git(
      "remote",
      "add",
      "origin",
      "https://github.com/LedgerHQ/revault.git",
    );
    const control = makeGitControl(makeProcessExecutor());
    const status = await run(
      control.integrationStatus(
        pathOf(scenario.repository.path),
        branchOf(scenario.parentBranch),
        branchOf(scenario.integrationBranch),
      ),
    );

    expect(status).toEqual({ kind: "current", ahead: 1, behind: 0 });

    await scenario.repository.checkout(scenario.parentBranch);
    await scenario.repository.commit("base.txt", "topic edit");
    await scenario.repository.checkout("main");
    await scenario.repository.commit("base.txt", "target edit");
    const conflict = await run(
      control.integrationStatus(
        pathOf(scenario.repository.path),
        branchOf(scenario.parentBranch),
        branchOf(scenario.integrationBranch),
      ),
    );
    expect(conflict.kind).toBe("conflict");
  });

  test("guarded rebase keeps the configured signing environment and leaves no operation on success", async () => {
    const repo = await repository();
    const base = await repo.tip("main");
    await repo.createBranch("topic", base);
    const worktree = join(repo.path, "topic-worktree");
    await repo.addWorktree(worktree, "topic");
    await repo.commit("topic.txt", "topic", worktree);
    await repo.commit("main.txt", "main");
    const control = makeGitControl(makeProcessExecutor());

    await run(
      control.guardedRebase({
        worktreePath: pathOf(worktree),
        branch: branchOf("topic"),
        targetBranch: branchOf("main"),
      }),
    );

    expect(await repo.git("merge-base", "--is-ancestor", "main", "topic")).toBe("");
    expect(await run(control.inspectWorktree(pathOf(worktree)))).toMatchObject({
      clean: true,
      checkedOutBranch: "topic",
    });
  });

  test("observes a conflicted rebase without continuing or aborting it", async () => {
    const repo = await repository();
    const base = await repo.tip("main");
    await repo.createBranch("topic", base);
    const worktree = join(repo.path, "conflict-worktree");
    await repo.addWorktree(worktree, "topic");
    await repo.commit("conflict.txt", "topic value", worktree);
    await repo.commit("conflict.txt", "main value");
    const control = makeGitControl(makeProcessExecutor());

    await expect(repo.rebase(worktree, "main")).rejects.toThrow();
    expect(await run(control.inspectWorktree(pathOf(worktree)))).toMatchObject({
      clean: false,
      operation: { kind: "rebase", conflict: true },
    });
  });

  test("fails closed when a Branch moves between stable-tip reads", async () => {
    const repo = await repository();
    const control = makeGitControl(makeProcessExecutor());
    const branch = branchOf("main");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        control.withStableTips(pathOf(repo.path), [branch], () =>
          Effect.promise(async () => {
            await repo.commit("race.txt", "moved");
            return "planned";
          }),
        ),
      ).pipe(Effect.provide(ProcessPlatformLive)),
    );

    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("A Branch tip moved");
  });
});
