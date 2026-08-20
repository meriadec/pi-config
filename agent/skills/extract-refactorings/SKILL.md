---
name: extract-refactorings
description: Factor feature-independent preparation out of selected commits and place it before the feature history.
argument-hint: "from commit <sha> | from the last <n> commits | from this branch"
disable-model-invocation: true
---

# Extract Refactorings

Perform **surgical factorization**: construct a small preparation stack on `main`, then replay the feature history with the selected **source commits** purified. Keep feature commit order, grouping, and intent stable. Preserve the final tree. A mostly additive source diff is a useful result, not an invariant.

## Steps

1. **Resolve the history.**
   - Require an empty `git status --porcelain`; ask the user to clean or stash any tracked, staged, or untracked changes.
   - Require `main` to be an ancestor of `HEAD`; ask for direction when the branch is not directly based on `main`.
   - Resolve a SHA as that source commit, “the last N commits” as the N commits ending at `HEAD`, and “this branch” as `main..HEAD`. Require each source to belong to `main..HEAD`.
   - Reject the operation when `main..HEAD` contains a merge commit. Record the original branch, `HEAD`, and `HEAD^{tree}`.
   - Completion: the source commits and linear branch history are unambiguous, the worktree is clean, and the restore state is recorded.

2. **Factor the transformations.**
   - Inspect each source commit against its parent and read the surrounding implementation needed to understand its intent. Give special attention to modified and deleted existing code.
   - Seek a feature-free intermediate implementation between the old implementation and the source result:
     - **Preparation**: behavior-preserving movement, extraction, renaming, interface cleanup, generalization, or another change useful on `main` before the feature exists.
     - **Feature**: behavior, concepts, tests, or wiring introduced for the feature.
     - **Entangled**: a transformation whose separation would expose feature concepts, change behavior, break an intermediate commit, or misstate intent.
   - Synthesize intermediate changes when factorization requires new hunks; preparation is not limited to moving original hunks.
   - Combine related preparation found in several sources when it forms one small coherent commit. Each preparation commit must apply to `main` or to earlier preparation commits, never to feature history.
   - Leave entangled transformations in their source commits. Keep unrelated and unselected commit intent unchanged.
   - Completion: each proposed preparation commit is feature-independent and correctly ordered from `main`; every source transformation has a preparation, feature, or entangled explanation; and the target history is fully mapped.

3. **Resolve doubtful seams.**
   - Proceed directly when the factorization is clear.
   - For doubtful behavior preservation, classification, grouping, or placement, show the smallest relevant before/preparation/feature transformation and ask the user to choose before rewriting history.
   - Keep a source unchanged when no clean preparation exists, and record why.
   - Completion: the factorization plan has no unresolved material decision.

4. **Reconstruct the branch.**
   - Rebuild from `main`: create the preparation commits first, then reconstruct the original branch commits in order. Remove extracted transformations only from selected sources; replay other commits with the same intent.
   - Create reconstructed commits through ordinary `git commit` so configured signing and hooks run. Use conventional subjects for preparation commits. Preserve source authors and messages; refresh a subject or body only when purification made it inaccurate.
   - Fix any conflict or failing intermediate commit before continuing.
   - Completion: the preparation stack precedes all feature history, source commits are purified as planned, and every reconstructed commit is coherent on its parent.

5. **Verify and report.**
   - Require the new `HEAD^{tree}` to equal the recorded tree and the worktree to be clean.
   - Inspect every new preparation and reconstructed source commit. Confirm that preparation contains no feature dependency and that each remaining source edit is feature work or justified entanglement. Use established relevant checks when hooks provide insufficient evidence.
   - Report the new ordered history with short SHAs, map preparation commits to their sources, and name unchanged sources or remaining non-additive edits with reasons. Give the original `HEAD` as the restore point. Leave pushing to the user.
   - Completion: tree equality holds, the branch is coherent and accurately described, checks pass, and the user has the new history and restore point.
