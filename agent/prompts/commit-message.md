---
description: Suggest a one-line Conventional Commit message for current uncommitted changes
---
Inspect the current uncommitted git changes, including both staged and unstaged files (`git status --short`, `git diff --cached`, and `git diff`).

Return exactly one nice one-line Conventional Commit message that summarizes the changes.

Rules:
- Use Conventional Commits format: `<type>(<optional-scope>): <description>`.
- Pick the most appropriate type (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, or `revert`).
- Include a scope only if it is obvious and helpful.
- Keep it concise, imperative, and lowercase after the colon.
- Do not include markdown, quotes, explanation, alternatives, or a commit body.
- Do not modify files and do not run `git commit`.
