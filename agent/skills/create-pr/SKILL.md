---
name: create-pr
description: Creates GitHub pull requests from the current repo context using the `gh` CLI, with a conventional-commit title and concise professional body. Use when the user asks to create, open, draft, or prepare a pull request/PR, including PRs from the current branch to a user-specified base branch.
---

# Create PR

Create a GitHub pull request from the current context. Default: current branch into the repo default branch, usually `main`. If the user names a target/base branch, create the PR against that branch instead.

## Quick start

1. Inspect repo state:
   - `git status --short --branch`
   - `git remote -v`
   - `git branch --show-current`
   - `gh repo view --json nameWithOwner,defaultBranchRef`
2. Determine base/head:
   - If the user specifies a target/base branch, use that exact branch as the base, even when it is not the repo default branch.
   - Otherwise, base defaults to the repo default branch, usually `main`; if repo default branch differs, prefer the default branch unless user explicitly specified `main`.
   - Head defaults to current branch.
   - Never create a PR from the base/default branch to itself.
3. Collect context:
   - User request/conversation notes.
   - Commits: `git log --oneline <base>..HEAD`
   - Diff summary: `git diff --stat <base>...HEAD`
   - Detailed diff if needed: `git diff <base>...HEAD`
   - Existing PR check: `gh pr list --head "$(git branch --show-current)" --json number,url,title,state`
4. Draft the PR:
   - Determine PR state: if the user explicitly asks for a "draft PR", "draft pull request", or says to create/open it as draft, set state to draft; otherwise create a regular ready-for-review PR.
   - Propose title, body, base, head, and state (draft or ready for review).
   - Ask for explicit confirmation before creating anything.
5. Refine with the user if requested:
   - Ask targeted questions, suggest tighter options, and continue until title/body/base/head are agreed.
6. Ensure branch is available on remote:
   - If not pushed: ask before pushing, then run `git push -u origin HEAD` after approval.
7. Create the PR only after final agreement:
   - Ready-for-review PR: `gh pr create --base <base> --head <head> --title '<title>' --body-file /tmp/pr-body.md`
   - Draft PR: `gh pr create --draft --base <base> --head <head> --title '<title>' --body-file /tmp/pr-body.md`

## Title rules

Use a conventional-commit subject, sharp and under ~80 chars.

- If there is exactly one commit in the PR, use its subject unless it is vague, too long, or not conventional; normalize only as needed.
- If there are multiple commits, synthesize a concise title that summarizes the PR.
- Format: `type(scope): subject`
- Valid common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, `ci`.
- Scope:
  - If a ticket exists, use it as scope: `feat(VG-123): add billing retry state`
  - Else use a meaningful domain/module scope: `fix(auth): handle expired sessions`
  - Omit scope if it adds noise: `docs: document stack workflow`
- Subject: imperative/lowercase unless proper noun; no trailing period.

## Body format

Write the body exactly in this shape. No giant markdown headings. No template leftovers. Do not hard-wrap body lines to a fixed column width (e.g. 80 chars); let each paragraph/bullet be a single line and rely on GitHub's soft wrapping, since manual line breaks render awkwardly there.

```md
A couple of sentences that gives high-level summary of PR purpose: why it exists, what changed, and how it works. Keep it human-digestible.

- Key point of interest.
- Another material change, tradeoff, or reviewer note.
- Anything risky, intentionally omitted, or worth looking at.

Optional extra information if genuinely useful.

Tested with: `<command>`
```

Omit the `Tested with:` line by default, especially when it would only repeat routine local checks that CI already covers. Include it only when the testing information is reviewer-useful beyond "CI will pass/fail", such as a manual reproduction, environment-specific verification, non-obvious smoke test, skipped test with meaningful reason, or validation that CI cannot run. Do not add filler like "Not run (PR creation only)" or "no validation command was provided".

Tone: sharp, precise, professional, unenthusiastic, and slightly bored. Add a tiny spark of fun only if it does not reduce clarity.

## Workflow

- Prefer facts from git over invention.
- Mention user-specified ticket IDs, issue links, constraints, and testing notes.
- Always show the proposed title/body/base/head/state before creation.
- Treat user phrases like "against <branch>", "into <branch>", "target <branch>", "base <branch>", or "to <branch>" as a request to use that branch as the PR base instead of the default branch.
- If the user requested a draft PR, create it with `gh pr create --draft`; do not create a regular PR and mark it draft later unless `gh pr create --draft` fails and the user approves the fallback.
- Do not run `gh pr create` until the user explicitly confirms.
- If the user wants changes, enter a refinement phase: identify unresolved parts, offer concrete alternatives, keep agreed wording, then summarize and ask for approval again.
- If tests were explicitly skipped for a meaningful reason, say so plainly. If validation is routine CI-equivalent or otherwise not reviewer-useful, omit testing status rather than inventing a useless sentence.
- If there is an existing PR for the branch, do not create a duplicate; offer to update title/body instead, with confirmation.
- If there are uncommitted changes, stop and ask whether to include/commit them or create the PR from committed work only.
- If the branch is behind base, still create the PR unless the diff is confusing or conflicts are visible; mention notable risk in the body.
- If `gh` is unauthenticated or repo remote is not GitHub, report the blocker and the exact next command the user should run.

## Quality checklist

Before creating:

- [ ] Base/head/state are correct.
- [ ] User has approved the final draft.
- [ ] Branch is pushed or push command is approved/ready.
- [ ] Title is conventional and <= ~80 chars.
- [ ] Body explains why/what/how with reviewer-relevant bullets.
- [ ] Testing status is omitted unless it is genuinely reviewer-useful beyond routine CI-equivalent checks.
- [ ] No oversized headers, hype, or vague filler.

After creating:

- Return the PR URL.
- Include title, base/head, and state.
- Mention tests only when there is concrete, reviewer-useful testing information beyond routine CI-equivalent checks.
