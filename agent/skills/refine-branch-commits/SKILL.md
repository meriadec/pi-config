---
name: refine-branch-commits
description: Reshape and rewrite a feature branch's full commit history into a clean stack of independent, one-on-top-of-another chunks ready for stacked PRs. Use when the user wants to fuse, reorder, split, or rearrange messy branch commits before opening the first PR, or asks to clean up commit history for stacking.
---

# Refine Branch Commits

Rewrite a feature branch's whole history into a **clean stack**: logical chunks that merge one on top of another as separate stacked PRs. This runs _before the first PR exists_, so the history is yours to reshape without hesitation — no published commits to preserve.

## The clean stack

The target shape, bottom to top. Each rung is a chunk that could be its own PR stacked on the one below it.

1. **Unrelated** — commits that do not belong to the feature (drive-by fixes, refactors, config). These merge to `main` first; the rest of the stack rebases on top once they land. One or several.
2. **Feature** — the feature itself. One commit when small, or split by concern (e.g. one back, one front) when that gives cleaner independent chunks. Feature commits may carry their own documentation.
3. **Documentation** — optional standalone commit for a full documentation addendum, only when it reads better separated from the feature commits.
4. **`chore: WIP`** — optional top commit holding residual junk the user will obviously drop (stray `console.log`, debug scraps, scratch files) — collected here instead of scattered across the history or given individual commits.

Only rungs 1 and 2 are required; 2 may itself be one commit. Rungs 3 and 4 appear only when they earn their place.

## Steps

1. **Rapid analysis — name the feature.**
   - `git branch --show-current`, `git status --short --branch`.
   - Find the base: `git merge-base HEAD main` (use the repo default branch if not `main`).
   - `git log --oneline --stat <base>..HEAD` to list every commit on the branch with its files.
   - Read the actual changes where intent is unclear: `git diff <base>..HEAD -- <path>`.
   - Completion: you can state in one sentence what feature this branch delivers, and you have the ordered list of current commits with the key files each touches.

2. **Thorough analysis — map every commit to a rung.**
   - Assign each existing commit (and each meaningful hunk, when a single commit mixes concerns) to a rung of the clean stack.
   - Look for: changes unrelated to the feature that should sink to the **Unrelated** rung; a natural back/front seam that argues for splitting the **Feature** rung; documentation worth its own rung; residual junk destined for `chore: WIP`.
   - Completion: every current change is accounted for on exactly one rung — nothing left unmapped, nothing double-counted.

3. **Propose the plan, then reach agreement.**
   - Present the target clean stack: each new commit, its conventional-commit subject, and which current commits/hunks fold into it.
   - For any commit that fuses several originals, propose a subject **and** body that describe the fused whole, not just the first original — a template-package commit that also absorbs a contracts package and an ADR must say so.
   - Call out every reshaping move: fusions, reorders, splits, and anything dropped.
   - Enter a turn-by-turn conversation and refine until the user agrees. The user may approve the first proposal immediately.
   - Completion: the user has explicitly approved a concrete plan. Do not touch history before this.

4. **Reshape and verify.**
   - Record the current `HEAD^{tree}` before changing history.
   - Reshape the history to match the approved plan (interactive rebase to reorder/squash/reword, or soft-reset the branch to `<base>` and rebuild the commits from staged hunks when fusions cut across the original boundaries).
   - Always commit with `--no-verify` to bypass pre-commit hooks. This step reshapes history, not the job the hooks check.
   - **Refresh every reshaped commit message.** For each commit that was fused, split, or had hunks moved in or out, re-read its final `git show --stat` and rewrite the subject and body to match what it now contains — never inherit a stale subject from one of the originals. Drop mentions of content that moved out; add mentions of content that moved in (extra packages, ADRs, docs, tests).
   - Verify the result: `git log --oneline <base>..HEAD` matches the plan, the final tree matches the recorded tree — unless the plan intentionally dropped something, in which case `git diff <base>..HEAD` contains exactly the approved content — and each commit's message accurately reflects its final `--stat`.
   - Completion: the branch history and final tree match the approved clean stack, and no commit carries a message left over from a pre-reshape shape.

5. **Report.**
   - Give a short recap of the new stack.
   - Name any hiccup or attention point (a conflict resolved, a hunk that was hard to place, an intentional drop).
   - Remind the user that pushing is their call.
