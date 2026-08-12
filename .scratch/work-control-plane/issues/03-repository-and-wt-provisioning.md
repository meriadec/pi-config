# Implement durable repository and wt provisioning

Status: done

## Context

Read the PRD and issues 01-02. `wt` already owns worktree naming and location conventions. Do not derive a worktree path from the repository or branch.

## Objective

Implement an idempotent provisioning service that validates or clones a base checkout and creates or recovers a topic worktree through `wt`.

## Scope

Add a provisioner behind a narrow injected process-runner interface.

Repository behavior:

- Resolve `owner/repo` to `<workBase>/<repo>` exactly.
- Validate that `workBase` exists and is a directory.
- If the base checkout exists, confirm it is a Git repository and normalize its `origin` to the requested GitHub `owner/repo`.
- Normalize common SSH and HTTPS GitHub remote forms, with optional `.git`.
- If the target path does not exist, enforce `repository.clone` policy and run `gh repo clone owner/repo target` with argument arrays.
- If the target path exists for another repository, return a conflict. Never overwrite it.

`wt` behavior:

- Enforce `topic.create-worktree` policy immediately before mutation.
- Run `wt` from the base checkout with the exact Branch and JSON output enabled.
- Use the equivalent of `wt switch --create <branch> --format json`; do not add a worktree naming convention.
- Parse supported `wt` JSON defensively and validate that the returned path is absolute and is a Git worktree for the expected repository.
- Before retrying creation, inspect actual Git/`wt` state. If the branch/worktree already exists, recover it rather than creating a duplicate.
- Never delete a successfully cloned base checkout during rollback.

Durability behavior:

- Persist `provisioning` before external work.
- Persist repository and worktree checkpoints after each successful step.
- Persist `ready` only after the returned worktree is validated.
- Persist `setup-failed` with a bounded reason after a terminal failure.
- Retry from `setup-failed` or interrupted `provisioning` idempotently.
- Make cancellation and process timeout explicit results.

Do not run dependency installation or repository hooks beyond what `wt` itself runs.

## Tests

Use temporary directories and a fake process runner. Cover:

- Existing matching SSH and HTTPS origins.
- Existing conflicting origin and non-Git target.
- Missing repository clone command arguments.
- Clone failure and timeout.
- Successful `wt` JSON parsing and stored returned path.
- Invalid, relative, missing, and oversized `wt` output.
- Retry after clone succeeded but `wt` failed.
- Recovery when the branch/worktree exists after an interrupted response.
- Policy `deny`, `ask`, and `allow` outcomes.
- The provisioner does not compute a worktree path from the repository and Branch.

Run `bun run check`.

## Acceptance criteria

- Provisioning can resume after every durable checkpoint without duplicate clone, branch, or worktree creation.
- The only topic worktree path accepted is one discovered from actual `wt`/Git state.
- Side effects use argument arrays, deadlines, and bounded output.
- The repository harness passes.

## Dependencies

- Issue 01

## Comments
