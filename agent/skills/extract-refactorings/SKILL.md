---
name: extract-refactorings
description: Extract feature-independent preparation from selected commits and place it earlier in the branch history.
argument-hint: "from commit <sha> | from the last <n> commits | from this branch"
disable-model-invocation: true
---

# Extract Refactorings

Purify selected **source commits** by moving feature-independent changes into small preparation commits before the feature changes that need them. Preserve the final tree. Prefer a mostly additive source commit when that shape follows naturally; reviewability and truthful commit boundaries take priority over an additive diff.

## Steps

1. **Resolve the source commits.**
   - Require an empty `git status --porcelain`; stop and ask the user to clean or stash any tracked, staged, or untracked changes.
   - Resolve the invocation to an ordered, contiguous set of commits reachable from `HEAD`. A specific SHA selects that commit; “the last N commits” selects the last N commits ending at `HEAD`.
   - For “this branch,” select `main..HEAD` only when `main` is an ancestor of `HEAD`. If the branch is not directly based on `main`, stop and ask the user what history to use.
   - Ask a focused question when the reference has more than one plausible meaning. Reject a selection that contains a merge commit.
   - Record the original `HEAD` and final tree before changing history.
   - Completion: one unambiguous, ordered source-commit set is known; the worktree is clean; the range has no merge commits; and the restore point and final tree are recorded.

2. **Classify every changed hunk.**
   - Inspect each source commit against its parent, with special attention to modified or deleted existing lines. Read enough surrounding code and later selected commits to understand why each hunk exists.
   - Classify each hunk as:
     - **Preparation**: a behavior-preserving rename, move, extraction, interface cleanup, generalization, or other feature-independent improvement that is useful and reviewable on the codebase before the feature exists.
     - **Feature**: behavior, concepts, tests, or wiring that belong to the feature itself, including necessary edits to existing lines.
     - **Entangled**: separation would introduce feature concepts early, break an intermediate commit, or make either commit misleading.
   - Find preparation hunks from different source commits that form one coherent change. They may become one earlier commit when that commit can stand independently before the earliest source that needs it.
   - Treat “mostly additive” as a direction, not an invariant. Leave entangled changes in their source commit.
   - Completion: every changed hunk is accounted for exactly once, each proposed preparation commit is feature-independent, and its required position in the history is known.

3. **Resolve doubtful boundaries.**
   - Continue without interruption for obvious preparation and feature boundaries.
   - When classification, grouping, placement, or behavior preservation is doubtful, show the smallest relevant proposed split and ask the user for confirmation before rewriting history.
   - If no clean preparation exists for a source commit, keep it unchanged and record the reason.
   - Completion: all material doubts have user decisions, and the extraction plan has no unresolved boundary.

4. **Rebuild the history.**
   - Rewrite the selected commits and any descendants needed to preserve branch order. Place each preparation commit before the earliest source commit that depends on it.
   - Make preparation commits small, meaningful, behavior-preserving, and suitable for an independent PR to `main`. Use conventional commit messages that describe the preparation itself.
   - Rebuild each source commit without the extracted hunks. Preserve feature changes and preserve unrelated commits. Refresh a source commit message when its new contents make the old message inaccurate.
   - Use the repository’s normal commit path so configured signing and hooks run. Fix a failing intermediate commit before continuing.
   - Completion: the planned preparation commits precede their dependent source commits, every rebuilt commit is coherent on its parent, and no change is lost or duplicated.

5. **Verify the purified stack.**
   - Confirm that the new `HEAD` tree equals the recorded final tree.
   - Inspect every rewritten commit and its message. Confirm that preparation commits contain no feature dependency and source commits retain only feature work plus justified entangled edits.
   - Use the repository’s established relevant checks when commit hooks do not provide enough evidence; keep validation proportional to the affected code.
   - Confirm that the rewritten range has no merge commits and the worktree is clean.
   - Completion: final-tree equality holds, every resulting commit is independently coherent and accurately named, checks pass, and the worktree is clean.

6. **Report.**
   - Show the new commits in order with short SHAs and subjects.
   - Map each preparation commit to the source commit or commits it purified.
   - Name source commits left unchanged, remaining non-additive edits, and the reason for each.
   - Give the original `HEAD` as the restore point. Leave pushing to the user.
