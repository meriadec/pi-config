---
name: resolve-conflicts
description: Analyze and resolve in-progress git conflicts (rebase, merge, cherry-pick, stash) by understanding both sides, applying trivial fixes automatically and asking for confirmation on non-trivial ones, then git add the resolved files WITHOUT committing or continuing. Use when the user is stuck on git merge/rebase conflicts or asks to resolve conflict markers.
---

# Resolve Conflicts

Resolve git conflicts during an in-progress operation. Understand what each side
intended, apply the best resolution, stage the result, and stop. **Never commit,
never `git rebase --continue`, never `git merge --continue`, never `git cherry-pick
--continue`.** Staging + a summary is the final step.

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

## 4. Stage and stop

After every conflict is resolved:

```sh
git add <each resolved file>
git status        # confirm nothing remains unmerged
```

Then report to the user:

- Which files were resolved and how (trivial vs confirmed-with-you).
- Confirm everything is staged.
- Remind them: **nothing was committed and the rebase/merge was NOT continued** —
  the next step (continue/commit/abort) is theirs to take.

Do not run `git commit`, `--continue`, or `--abort` unless explicitly told to.
