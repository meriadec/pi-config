---
name: create-pr
description: Creates GitHub pull requests from the current repo context using a deterministic local workflow and the `gh` CLI. Use when the user asks to create, open, draft, or prepare a pull request/PR, including PRs to a specified base branch.
---

# Create PR

Prepare and create a GitHub pull request from the current repository. The bundled helper owns repository inspection, safety checks, pushing, and PR creation. Run it from the target repository and resolve `scripts/create-pr.ts` relative to this skill directory.

## Images and videos: `gh` CAN attach them

`gh pr create --attach '<file>#<alt text>'` (also `gh pr comment`, `gh issue create`) uploads a local image or video to GitHub and puts its URL in the body. This is supported by current `gh`; do not claim `gh` cannot upload files, and do not tell the user to drag the file in by hand. If unsure, run `gh pr create --help` and read the `--attach` entry.

- When the user mentions a screenshot, GIF, or video for the PR, ask for or accept its path. Use it with `--attach` through the helper (step 5). The path may be outside the repository, because the user named it.
- To place the image in the body, reference the same path: `![alt text](<absolute-path>)`; `gh` rewrites it to the uploaded URL. Without a reference, `gh` appends the attachment at the end of the body.
- Also check the user's AGENTS.md for attachment instructions before you draft.

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

3. Draft the title and body from Git facts and conversation context. If the user supplied images or videos, plan them as `--attach` values and show them in the proposal. Select exact labels from `availableLabels` and repository guidance.

4. Show the proposed title, body, base, head, state, labels, and push action. Ask for explicit confirmation. Refine the proposal until all fields are approved.

5. After confirmation, stream the exact approved body to the helper. Include `--draft` only for an approved draft PR, repeat `--label` for each approved label, and repeat `--attach` for each image or video the user supplied:

   ```bash
   cat <<'PI_PR_BODY' | bun <skill-directory>/scripts/create-pr.ts create \
     --confirmed \
     --base <base> \
     --head <head> \
     --title '<title>' \
     [--draft] \
     [--label '<exact label>'] \
     [--attach '<absolute-file-path>#<alt text>']
   <approved body>
   PI_PR_BODY
   ```

   The helper requires a clean worktree, the current same-named head branch, `origin`, an exact existing label match, existing attachment files (else `missing_attachments`), and a conventional title. It performs a normal push without force, sends the body to `gh pr create --body-file -`, and emits one bounded JSON result.

6. Handle the result by its stable `code`:

   - `created`: return the PR URL, title, base/head, and state.
   - `existing_pr`: return the existing PR and do not create a duplicate.
   - `missing_attachments`: report the missing paths and ask the user for the right ones.
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

Use a direct `gh` workflow only when the bundled helper cannot execute because Bun or the script is unavailable. Preserve the same inspection, confirmation, clean-tree, duplicate, label, push, and title checks. Stream the approved body through stdin with `gh pr create --body-file -` and add `--attach` for each supplied image or video; use no temporary body file.
