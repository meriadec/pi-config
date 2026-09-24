---
name: create-pr
description: Creates GitHub pull requests from the current repo context using a deterministic local workflow and the `gh` CLI. Use when the user asks to create, open, draft, or prepare a pull request/PR, including PRs to a specified base branch.
---

# Create PR

Prepare and create a GitHub pull request from the current repository. The bundled helper owns repository inspection, safety checks, pushing, and PR creation. Run it from the target repository and resolve `scripts/create-pr.ts` relative to this skill directory.

## Workflow

1. Inspect the repository with the helper:

   ```bash
   bun <skill-directory>/scripts/create-pr.ts inspect [--base <branch>]
   ```

   Use the user-specified base exactly. Otherwise, let the helper select the GitHub default branch.

2. Read the JSON result. It includes the base and head, clean state, commits, changed paths, bounded diff statistics, push state, existing PRs, available labels, and package-label candidates.

   - If the worktree is dirty, inspect the changes. Commit clearly related changes with a focused signed commit after suitable validation. Ask the user about ambiguous or unrelated changes. Then run `inspect` again.
   - If a PR already exists, show its URL and offer to update it as a separate operation.
   - Read a detailed diff only when the commit list, paths, and statistics do not explain the change.

3. Draft the title and body from Git facts and conversation context. Select exact labels from `availableLabels` and repository guidance.

4. Show the proposed title, body, base, head, state, labels, and push action. Ask for explicit confirmation. Refine the proposal until all fields are approved.

5. After confirmation, stream the exact approved body to the helper. Include `--draft` only for an approved draft PR and repeat `--label` for each approved label:

   ```bash
   cat <<'PI_PR_BODY' | bun <skill-directory>/scripts/create-pr.ts create \
     --confirmed \
     --base <base> \
     --head <head> \
     --title '<title>' \
     [--draft] \
     [--label '<exact label>']
   <approved body>
   PI_PR_BODY
   ```

   The helper requires a clean worktree, the current same-named head branch, `origin`, an exact existing label match, and a conventional title. It performs a normal push without force, sends the body to `gh pr create --body-file -`, and emits one bounded JSON result.

6. Handle the result by its stable `code`:

   - `created`: return the PR URL, title, base/head, and state.
   - `existing_pr`: return the existing PR and do not create a duplicate.
   - `dirty_worktree`, `head_mismatch`, `unsafe_upstream`, `unknown_labels`, or `push_rejected`: report the stated blocker and recovery facts.
   - `pr_create_failed` with `pushed: true`: report that the branch is available remotely, fix the stated GitHub failure, re-inspect, and retry creation safely.

## Drafting rules

### Title

Use a sharp conventional-commit subject of at most 80 characters.

- Use the sole commit subject when it is clear and conventional.
- Synthesize one subject when the PR has multiple commits.
- Format: `type(scope): subject`. Common types are `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `build`, and `ci`.
- Use a ticket as scope when one exists; otherwise use a useful domain scope or omit noisy scope.
- Use an imperative subject with no trailing period.

### Body

Write the body in this shape without large headings, template remnants, or hard-wrapped prose:

```md
A short high-level summary that explains why the PR exists, what changed, and how it works.

- A material implementation point.
- A tradeoff or reviewer note.
- A risk, intentional omission, or other useful fact.

Optional extra information when genuinely useful.
```

Use a precise, professional, unenthusiastic tone. Prefer facts from Git over invention. Mention user-provided tickets, links, constraints, and meaningful testing notes.

Omit routine CI-equivalent test status. Add `Tested with:` only for reviewer-useful manual, environment-specific, non-obvious, skipped, or CI-unavailable validation.

## Fallback

Use a direct `gh` workflow only when the bundled helper cannot execute because Bun or the script is unavailable. Preserve the same inspection, confirmation, clean-tree, duplicate, label, push, and title checks. Stream the approved body through stdin with `gh pr create --body-file -`; use no temporary body file.
