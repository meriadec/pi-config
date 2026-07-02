---
name: pr-review-triage
description: Fetches active GitHub pull request review threads plus top-level PR discussion, analyzes feedback, prepares a user-reviewed action plan, applies approved code changes, creates local signed commits when appropriate, and posts/resolves approved replies after the fixes are pushed. Use when the user asks to handle PR review comments, triage GitHub PR feedback, respond to reviewers, discard review feedback, or prepare responses to PR comments.
---

# PR Review Triage

## Quick start

1. Confirm the PR number or infer it with `gh pr view --json number,url`.
2. Fetch active feedback using the helper script bundled with this skill. Resolve `scripts/active-pr-review-threads.sh` relative to this skill file's directory, not the target repository cwd:

   ```bash
   <skill-dir>/scripts/active-pr-review-threads.sh <pr-number> > /tmp/pr-review-feedback.json
   ```

3. Also fetch unresolved outdated review threads with GitHub CLI/GraphQL; include them unless they already have an adequate reply.
4. Analyze each active review thread, unresolved outdated thread, top-level PR comment, and non-empty review summary.
5. Produce a scannable report; discuss/revise until the user approves the implementation plan + local commit, or cancels.
6. Only after implementation approval: apply planned code changes, run project checks, and create focused local signed commits for coherent fixes.
7. Stop after the local commit and ask for the second approval gate: push + approved replies/resolutions.
8. Only after push/response approval: push the committed fixes, post approved replies on every addressed review thread, then resolve/discard approved review threads.

## Workflow

### 1) Collect context

- Inspect repo guidance (`README`, `CONTEXT.md`, `AGENTS.md`, package scripts) before judging feedback.
- Use GitHub CLI; do not rely on stale local review text.
- Active review threads are unresolved and not outdated; unresolved outdated threads may still need a closing reply and resolution.
- Do not leave addressed review threads silently resolved. If a thread is fixed by code/docs/tests, even if GitHub marks it outdated, plan a reply that references the fixing commit with subject and link, e.g. `Resolved in \`fix: harden snapshots benchmark reporting\` (https://github.com/org/repo/commit/<sha>) ...`, before resolving.
- Only leave an unresolved outdated thread open when it contains a still-relevant question or discussion that was not answered by the commit.
- Top-level comments/review summaries have no obsolete/discard state.
- Keep IDs, URLs, authors, paths, and lines in the report for auditability.

### 2) Analyze every feedback item

For each item, classify:

- **Feedback type**: bug, correctness, security, performance, maintainability, API/design, UX, style/nit, question, docs/test gap, duplicate, unclear, not applicable.
- **Severity**: blocker, important, minor, nit, informational.
- **Legitimacy**: must fix, very legit, reasonable, debatable, bikeshedding, reviewer mistaken, stale/not applicable, stupid but harmless.
- **Disposition**: address with code, address with docs/tests, reply only, discard/resolve with explanation, ask clarifying question.
- **Risk if ignored**: concrete failure mode, user impact, reviewer confidence cost, or “none beyond preference”.
- **Evidence**: cite code, tests, product constraints, or repo conventions.

Be blunt but professional. If feedback is wrong, say why. If reviewer is right, say so.

### 3) Produce the review report

Make it scannable and mark anything needing user attention.

```md
# PR review triage report

## Summary

- Active review threads: N; unresolved outdated threads needing reply/resolution: O; top-level comments: M; review summaries: K
- Plan: X code changes, Y reply-only, Z discard/resolve, W clarify
- High-risk items: ...

## Proposed actions

| ID  | Source | Type | Severity | Legitimacy | Plan | Needs user decision? |
| --- | ------ | ---- | -------- | ---------- | ---- | -------------------- |

## Details

### R1 — <source/path:line> — <short title>

- URL/ID/author: ...
- Reviewer said: ...
- Analysis: ...
- Plan: address / reply only / discard-resolve / clarify
- Draft PR reply, if any: ...
- If code change: files likely touched and validation command
- Important caveats/user decision: ...
```

After the report, stop and ask the user to review, modify, approve implementation + local commit, or cancel. Make clear this first approval does not authorize push, GitHub replies, or thread resolution; those require the second approval gate after the local commit exists.

### 4) Approved implementation phase

Only if the user approves the implementation plan + local commit:

- Implement approved code changes.
- Run relevant checks (`bun run ci`, `bun run format`, `bun test`, `npm test`, `pnpm test`, or repo-specific commands).
- If checks fail, fix or report clearly.
- Review `git diff`/`git status`, stage only intended changes, and create focused local signed commits with concise conventional-commit messages.
- Ask the user to review/validate when the result involves judgment you cannot verify locally.
- Stop after the local commit. Report the commit, verification, and exact push/reply/resolve actions you propose next.
- Do not push, post PR replies, or resolve/discard review threads during this phase.

### 5) Approved push + GitHub response phase

Only if the user approves the second gate (push + replies/resolutions) after the local commit exists:

- Push the approved local commit(s).

- Re-fetch unresolved review threads, including outdated ones, before posting responses.
- Post approved review-thread replies before resolving; resolve only threads approved for discard/resolve or fully addressed.
- For every thread addressed by a committed fix, post a concise closure reply that references the fixing commit subject and link, then resolve. This applies to both still-active and outdated threads.
- For threads made outdated by the commit but not yet replied to, use the same commit-referencing closure reply, then resolve.
- Top-level PR comments cannot be resolved; post a new PR comment that references the author/comment URL if approved.
- Do not resolve “reply only” threads unless the user approved resolution.
- Do not resolve any thread without a visible reply unless it already has an adequate prior reply in the thread. For fixed-by-commit threads, an adequate reply must include the fixing commit subject and link.
- Keep unresolved only when an unanswered reviewer question or discussion remains relevant after the commit.
- Report links to posted comments/resolved threads.

## GitHub mutations

```sh
# Reply to review thread
gh api graphql -f query='mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{url}}}' -f id='THREAD_ID' -f body='MESSAGE'
# Resolve thread
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}' -f id='THREAD_ID'
# Top-level PR reply
gh pr comment PR_NUMBER --body 'MESSAGE'
```

## Safety rules

- Local signed commits are allowed after the implementation plan + local commit gate is approved and checks have run.
- Pushes, PR replies, and review-thread resolutions/discards share a separate second approval gate after the local commit exists.
- Never treat implementation approval as push/reply/resolve approval.
- Never post, resolve, discard, or push without explicit user approval for the second gate.
- Never silently resolve a review thread. Add a reply first, or verify an adequate reply already exists.
- Preserve reviewer intent; do not hide valid feedback behind vague replies.
- Prefer addressing legitimate correctness/security/test comments over arguing.
- If a thread cannot be confidently classified, mark it “clarify” and ask the user.
