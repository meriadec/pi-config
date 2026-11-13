---
name: stack-and-peel
description: Land a multi-commit feature branch on main as one squash-merged PR per commit, bottom commit first.
disable-model-invocation: true
---

# Stack and peel

The **stack** is the local feature branch: a list of commits above `origin/main`. The **peel** is the bottom commit, pushed as its own PR branch. One peel is open at a time. The stack stays the source of truth, and the repo guide (`docs/agents/pull-requests.md`) owns PR rules such as title, labels and changesets.

## Contract

Ask the user once, before the first step. Done when each item has an answer:

- Merge type (default: squash and merge).
- Base branch (default: `main`).
- Gates: default is to ask before each push, PR creation, thread reply and Copilot request. The phrase "go alone" removes the gates for the rest of the run.
- Checkout: always use a worktree for the peel and run checks on it. Choose the folder name yourself (for example `../<repo>-peel-<topic>`). Do not ask the user.

## Loop

1. **Back up and rebase.** `git branch backup/<stack>-pre-land`, `git fetch origin`, `git rebase origin/main`.
   Conflicts in `package.json` and `pnpm-lock.yaml`: keep the newer versions from `main`, add the stack's new entries, and regenerate the lockfile with `pnpm install --lockfile-only`.
   Done when `git log --oneline --reverse origin/main..HEAD` lists the expected commits and no conflict marker remains.
2. **Peel.** Name the PR branch `feat/<jira-key>_<topic>` from the bottom commit. A name nested inside the stack branch name fails, because git cannot hold `a` and `a/b` together. Create it with `git branch <pr-branch> <bottom-sha>`.
   Done when `git rev-list --count origin/main..<pr-branch>` is 1.
   **Last commit of the stack** (`git rev-list --count origin/main..<stack>` is 1): there is no peel. The stack branch is the PR branch. Skip this step and the `git branch`, push the stack branch with `-u` (the user approves the push, and a rebase needs `--force-with-lease`), and use the stack branch as `<pr-branch>` in the next steps. In step 4, commit fixes on the stack branch and push them. In step 6, `git rebase` is not needed: `git fetch`, then reset or delete the stack branch with approval.
3. **Open the PR.** Push with `git push -u origin <pr-branch>`, so the local PR branch tracks the remote one. Then use the `create-pr` skill. The user approves title, body, labels and branch name first.
   Done when the PR URL is reported.
4. **Review loop.** Fetch feedback with the `pr-review-triage` skill. Fix as new commits on the PR branch, never a rewrite:
   ```bash
   git checkout -b tmp-fix <pr-branch>      # red test first, then the fix, then commit
   git branch -f <pr-branch> tmp-fix
   git push -u origin <pr-branch>           # -u every time: the PR branch always has an upstream
   git checkout <stack>
   git rebase --onto <pr-branch> <previous-pr-tip>
   git branch -D tmp-fix
   ```
   Check that the push exit code is 0 and `git rev-parse <pr-branch> origin/<pr-branch>` shows one sha, before any reply, resolve or Copilot request.
   After the push: reply to each thread with the fix commit, resolve it, then run `gh pr edit <n> --add-reviewer @copilot` and stop. That call cannot be verified, so do not retry it.
   Done when 0 threads are unresolved and CI is green.
5. **Watch.** Poll only when the user asks: every 1 minute with `gh`, stop on a new review or a merge, report what changed. A polling loop blocks the conversation, so say that before it starts.
   Done when the PR state is `MERGED`.
6. **Land.** `git fetch`, then `git rebase --onto origin/main <last-pr-branch-tip>` on the stack. Squash-merge makes new SHAs, so the peeled commits do not match and the plain rebase conflicts. Then delete the PR branch (local and remote) and the worktree, with approval.
   Done when the stack's bottom commit is the next commit to peel. Go to step 1 for it, or stop when the stack is empty.

## Gotchas

- No `pull_request` run after a push: check https://www.githubstatus.com before you reopen the PR or push an empty commit.
- A PR created seconds ago shows an empty check list. Read it again after a minute.
- Keep each commit's author. Keep the commit signing.
- Every push of a branch uses `-u`, and a failed push stops the run: a missing upstream makes a plain `git push` fail. Never reply to a thread or request a review before the push succeeds.
- Never push the stack branch unless the user asks.

## Report

After each step: the PR URL, the commit SHAs, and `git status -sb` of the stack.
