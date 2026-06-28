---
name: resolve-conflicts
description: Analyze and resolve in-progress git conflicts (rebase, merge, cherry-pick, stash) by understanding both sides, applying trivial fixes automatically and asking for confirmation on non-trivial ones, then stage and, when appropriate, commit/continue the in-progress operation. Use when the user is stuck on git merge/rebase conflicts or asks to resolve conflict markers.
---

# Resolve Conflicts

Resolve git conflicts during an in-progress operation. Understand what each side
intended, apply the best resolution, stage the result, then complete the local git
operation when it is safe and within the user's request. Local signed commits and
`--continue` steps are allowed; destructive operations such as `--abort`, resets,
or force pushes still require explicit user approval.

## 1. Understand the situation

Run these to learn the operation and the conflicting files:

```sh
git status                       # operation in progress + conflicted files
git diff --name-only --diff-filter=U   # list unmerged files
```

Detect the operation type so you label sides correctly:

- Rebase in progress: `.git/rebase-merge` / `.git/rebase-apply` exists.
- Merge in progress: `.git/MERGE_HEAD` exists.
- Cherry-pick: `.git/CHERRY_PICK_HEAD` exists.

**Sides are confusing — get them right:**

- In a **merge**: `ours`/`HEAD` = your current branch; `theirs` = branch being merged in.
- In a **rebase**: it is SWAPPED. `ours`/`HEAD` = the base branch you're replaying
  onto; `theirs` = the commit from your branch being replayed. Say this explicitly
  to the user when summarizing.

## 2. Understand each side's intent

For each conflicted file, inspect both versions and the history behind them:

```sh
git log --merge -p -- <file>     # commits touching this file from both sides
git show :1:<file>               # common ancestor (base) version
git show :2:<file>               # "ours" version
git show :3:<file>               # "theirs" version
```

Read surrounding code so the resolution is semantically correct, not just a
marker deletion. Identify whether both sides changed the same logic, or whether
the changes are independent and should both be kept.

## 3. Resolve each conflict

Classify each conflict:

- **Trivial** — fix directly without asking. Examples: pure import/whitespace
  ordering, lockfile regeneration, both sides added non-overlapping lines,
  version bumps, one side is a strict superset, formatting-only differences.
- **Non-trivial** — STOP and ask the human. Examples: both sides changed the same
  logic, ambiguous business intent, deletions vs edits, API/signature changes,
  anything where picking wrong would lose work or change behavior.

When asking, present: what each side did, the options (keep ours / keep theirs /
combine / custom), and your recommendation. Wait for the answer before editing.

Remove all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and ensure the file
is coherent.

## 4. Stage and complete

After every conflict is resolved:

```sh
git add <each resolved file>
git status        # confirm nothing remains unmerged
```

Then finish the local operation when appropriate:

- Rebase/cherry-pick: run the corresponding `git rebase --continue` or `git cherry-pick --continue` if all conflicts are resolved and the resolution does not require further human judgment.
- Merge: create the merge commit if the user's request was to complete the merge; otherwise leave the resolved files staged and explain the next step.
- Stash apply/pop or standalone conflict cleanup: create a focused signed commit only if the user's request includes committing the resolved result or the surrounding workflow normally expects a commit.

Then report to the user:

- Which files were resolved and how (trivial vs confirmed-with-you).
- What git operation was completed, including commit hash/message when a commit was created.
- Any remaining manual next step if the operation was intentionally left staged.

Do not run `--abort`, reset, force push, or otherwise discard/rewrite work unless explicitly told to.
