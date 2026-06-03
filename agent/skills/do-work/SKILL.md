---
name: do-work
description: Executes technical repository work from a user instruction with repo exploration, selective human-in-the-loop clarification, approval-gated implementation, validation, and cleanup. Use when the user asks to do, implement, fix, refactor, wire, or change code in the current repo, especially via /skill:do-work.
---

# Do Work

Use this workflow to carry out a technical instruction in the current repository while keeping the human in the loop only at meaningful decision points.

## Operating principles

- Treat the user's instruction as the work request; infer intent from the current repo where possible.
- Explore before asking. Read relevant docs, tests, configs, existing patterns, and nearby code first.
- Ask the human only when a point requires particular attention: irreversible tradeoff, product ambiguity, data-loss/security risk, incompatible options, missing credential/environment, or high-cost path choice.
- When asking, state the dilemma clearly, list viable options with tradeoffs, and give a recommendation.
- Do not ask for confirmation after every step. Batch non-blocking assumptions into the plan.
- Do not commit, amend, tag, push, or otherwise alter VCS history unless explicitly instructed.

## Workflow

### 1. Understand and explore

1. Inspect repository shape and status (`pwd`, `git status --short`, file tree/search as needed).
2. Identify the relevant language/framework/package manager and available harnesses from files such as README, package manifests, Makefile, task files, CI config, test config, and existing scripts.
3. Read the code and tests around the requested change.
4. Form an implementation approach that follows existing style, architecture, and domain language.

### 2. Human-in-the-loop clarification, only if needed

If exploration reveals a real dilemma, pause and ask in this format:

```md
Dilemma: <one-sentence decision to make>

Options:
1. <option> — <main benefit>; <main cost/risk>
2. <option> — <main benefit>; <main cost/risk>

Recommendation: <recommended option and why>

Please choose, or approve the recommendation.
```

Continue without asking when a reasonable local convention or low-risk default is available; mention the assumption in the plan.

### 3. Approval gate before implementation

Before editing, ask for human approval with a concise plan. Include only the most important points:

```md
Plan:
- <key change / affected area>
- <key validation harnesses to run>
- <important assumption or risk, if any>

Approve to proceed?
```

Do not start implementation until the human approves.

### 4. Implement

After approval:

1. Make the smallest coherent change that satisfies the instruction.
2. Preserve existing behavior unless the task requires changing it.
3. Add or update tests when the repo's patterns indicate tests are expected.
4. Keep changes easy to review: focused edits, clear names, no unrelated cleanup.

### 5. Validate with repo harnesses

Run the corresponding/recommended harnesses discovered during exploration, such as targeted tests first, then broader checks when appropriate:

- Unit/integration tests for touched areas
- Typecheck
- Lint/format checks
- Build or package verification
- Any documented project-specific verification command

If a harness cannot run, explain why and what would be needed.

### 6. Review, polish, and refactor lightly

After validation:

1. Review the diff and touched files.
2. Clean up odd, brittle, duplicated, or unclear code introduced by the change.
3. Re-run any affected harness if polishing changes behavior or compiled output.
4. Check `git status --short` and summarize changed files.

### 7. Final handoff

Report concisely:

- What changed
- Validation commands and results
- Any assumptions, follow-ups, or skipped checks
- Explicitly state that no commit was made

End by asking the human what they want next, especially if follow-up decisions remain.
