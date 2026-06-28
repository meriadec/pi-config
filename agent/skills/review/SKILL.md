---
name: review
description: Reviews the current branch before PR creation from a clean git state, comparing against a base branch and producing a concise, human-digestible findings summary and fix plan. Use when the user invokes a pre-PR/code review, asks to review current work, or mentions comparing the branch to main before opening a PR; honor any review hints or narrowed scope supplied by the user.
---

# Review

Pre-PR code review for the current branch. The goal is judgment, not finding issues for its own sake: report only relevant, actionable findings, and say clearly when nothing material is found.

## Hard stop: clean git state

Before reviewing, verify the repo is clean:

```bash
git rev-parse --show-toplevel
git status --porcelain=v1 --untracked-files=all
```

If status output is non-empty, stop the review and explain that review requires a clean worktree/index so findings correspond exactly to committed branch work. If the dirty changes clearly belong to the branch and the user asked you to prepare/review current work end-to-end, you may validate and create a focused local signed commit first, then restart the review. Do not stash, reset, discard, or otherwise rewrite work without explicit approval.

## Establish review scope

1. Identify base branch:
   - Use user-specified base if provided.
   - Else use `main`.
   - If `main` does not exist, ask the user.
2. Compare with merge-base syntax unless instructed otherwise:

```bash
git diff --stat <base>...HEAD
git diff --name-status <base>...HEAD
git log --oneline --decorate <base>..HEAD
```

3. Apply user hints as priority focus, not tunnel vision. Still flag serious unrelated risks if encountered.
4. Read changed files and nearby existing code to understand local conventions before judging naming, structure, duplication, or style.

## Review lenses

Inspect the diff through these lenses, in roughly this order:

- Correctness: edge cases, control flow, data shape assumptions, regressions, races, idempotency.
- Contracts: API boundaries, public interfaces, backward compatibility, migrations, config/env behavior.
- Tests: coverage of changed behavior, meaningful assertions, missing negative/edge cases, test fragility.
- Maintainability: duplication, cohesion, complexity, naming consistent with the codebase's domain language.
- Architecture fit: whether new responsibilities live in the right layer/module and reuse existing abstractions.
- Resilience: error handling, logging/observability, retries/timeouts, cleanup paths.
- Security/privacy: authz/authn, injection, secret handling, sensitive logs, unsafe dependencies.
- Performance: avoid material regressions, unnecessary repeated work, N+1s, expensive sync paths.
- UX/docs/devex where relevant: messages, README/docs, changelog, generated files, examples.

Prefer concrete evidence over broad advice. Cite `path:line` wherever possible. Avoid subjective nits unless they materially affect comprehension or maintainability.

## Validation

Run lightweight validation when project signals are clear and commands are safe, e.g. package scripts, test commands, linters, type checks. First inspect available scripts/configs. Do not install dependencies or run destructive/expensive commands without asking.

Record exactly what was run and the result. If validation was skipped, explain why.

## Severity scale

- **Blocker**: likely bug/data loss/security issue or PR should not merge.
- **High**: important correctness/compatibility/test gap that should be fixed before PR/merge.
- **Medium**: meaningful maintainability, resilience, or coverage issue worth addressing.
- **Low**: minor but actionable improvement.
- **Nit**: optional polish; include sparingly.

## Output format

End with this structure:

```md
## Review summary

**Base:** <base>  
**Scope:** <files/commits reviewed; mention user hints if any>  
**Verdict:** <Ready for PR | Ready with follow-ups | Needs fixes before PR | Blocked>

### Findings

| ID  | Severity | Area        | Evidence    | Why it matters | Suggested fix |
| --- | -------- | ----------- | ----------- | -------------- | ------------- |
| R1  | High     | Correctness | `path:line` | ...            | ...           |

If no material findings: "No material findings."

### Suggested fix plan

1. <ordered, practical steps to address findings>
2. <include tests/validation to run after fixes>

### Validation performed

- `<command>` — <pass/fail/notes>

### PR notes

- <risks, reviewer callouts, or testing notes useful for the PR body>
```

Keep the summary digestible. Group duplicate instances under one finding. Do not change code during review unless the user explicitly asks to implement fixes.
