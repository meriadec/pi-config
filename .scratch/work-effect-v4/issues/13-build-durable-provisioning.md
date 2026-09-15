# Build durable Topic provisioning

Status: ready-for-agent

Depends on: 03, 04, 07, 08, 10, 12

Suggested commit: `feat(work): implement durable Topic provisioning`

## Read first

- `../PRD.md`, especially Durable Operation lifecycle, Repository Recipe rules, Cancellation, and Concurrency
- current `daemon/provisioner.ts`, Topic creation flows, and related integration tests

## Objective

Implement root and child Topic creation, setup retry, and cancellation as checkpointed Durable Operations.

## Scope

1. Validate and accept root and child creation in short transactions.
2. Preserve repository-and-Branch uniqueness and exact Start Point rules.
3. Snapshot the selected Recipe and policy context for one attempt.
4. Implement durable checkpoints for Base checkout validation, clone, Branch creation, Worktree discovery or creation, Worktree validation, each Setup command, and ready state.
5. Keep external work outside SQL transactions.
6. Apply policy before each sensitive mutation and enter durable awaiting-confirmation state when required.
7. Resume deterministic checkpoints after restart.
8. Mark a command that was running at lost supervision as `setup-interrupted`.
9. Make explicit Retry Setup start from command one with the latest Recipe.
10. Implement confirmed Cancel Setup with process-group interruption and durable cancelled result.
11. Activate a pending child only after ready setup and current ancestry revalidation.
12. Publish semantic bounded progress without raw command output or command text.
13. Port real Git, failure, confirmation, restart, cancellation, and concurrent creation tests to the operation interface.

## Acceptance

- Client loss does not cancel accepted provisioning.
- Daemon restart resumes deterministic work and never guesses an uncertain Setup result.
- Retry, cancel, duplicate request, and Branch conflict behavior is durable.
- A failed child setup cannot corrupt the active Integration Chain.
- Start Point data remains creation input and is not stored on a root Topic.
- `bun run check` passes.

## Comments
