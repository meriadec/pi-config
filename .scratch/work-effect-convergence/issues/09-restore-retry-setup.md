# Restore Retry Setup

Status: done

## Parent

`../PRD.md`

## What to build

Restore Retry Setup as a complete action for a Topic whose Repository Recipe failed or was interrupted. Retry starts one new Durable Operation from command one and keeps the previous Topic identity, Branch, Worktree, family, and Partition.

## Acceptance criteria

- [ ] Retry Setup appears only for `setup-failed` and `setup-interrupted` Topics and includes exact unavailable reasons when blocked by policy or active work.
- [ ] Retry enforces `topic.run-setup` policy and uses direct confirmation only for `ask`.
- [ ] One retry request starts one durable attempt with a stable request identity.
- [ ] Every Recipe command runs again from command one; no completed checkpoint is silently skipped.
- [ ] Progress, current command detail, interruption, failure, cancellation, and readiness are visible in the dashboard.
- [ ] Retry does not recreate or move the Branch or Worktree and does not change Topic family metadata.
- [ ] Public action, policy, operation-recovery, and component tests cover failed and interrupted Setup.
- [ ] The root harness passes.

## Blocked by

- `07-restore-dashboard-root-topic-creation.md`
