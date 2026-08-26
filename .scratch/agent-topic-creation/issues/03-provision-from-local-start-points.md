# 03 — Provision Topic Branches from local Start Points

Status: done
Type: feature
Blocked by: 02
Affected extension: `work`

## Context

A Start Point comes from a Source worktree in the same local clone as the daemon's Base checkout. All worktrees share one Git object database, so the provisioner must validate that relationship and create the Topic Branch without moving an existing Branch.

The current provisioner creates a missing Branch from the repository default branch. It also adopts an existing Branch without checking a requested Start Point.

## Scope

- Validate the Source checkout before mutation:
  - resolve its real worktree root;
  - prove it is a Git repository;
  - normalize its `origin` and require the requested GitHub repository;
  - prove the supplied full SHA exists there as a commit;
  - require it to share the Base checkout's Git common directory.
- Reject a Source checkout from a separate clone. Do not transfer Git objects between clones.
- Use argument arrays, bounded output, existing process timeouts, and cancellation. Do not run a shell command built from a path, Branch, or SHA.
- Apply `topic.create-worktree` policy before Branch or Worktree creation. `deny` stops all mutation, and `ask` returns through the existing confirmation flow.
- Implement Branch rules:
  - no Start Point keeps current default-branch and existing-Branch behavior;
  - a missing Branch with a Start Point is created at that exact commit;
  - an existing Branch with a Start Point is adopted only when its current tip equals the commit;
  - a mismatch returns a structured conflict and leaves the Branch unchanged.
- Validate the final Worktree repository, Branch, and commit before recording `ready`.
- Preserve Repository Recipe behavior: a Recipe runs only for a newly created Worktree and follows the existing retry rules.
- Leave no Start Point or Source checkout in the manifest after success or failure.

## Acceptance criteria

- [ ] A commit selected from a Source worktree produces a Topic Branch at the exact SHA in the shared Base repository.
- [ ] HTTPS and SSH origins that normalize to the requested GitHub repository are accepted.
- [ ] A different origin, separate clone, missing commit, non-commit object, non-repository path, or path that is not the validated worktree is rejected before Branch or Worktree mutation.
- [ ] An existing Branch at the Start Point is adopted without moving it.
- [ ] An existing Branch at another commit returns a conflict and keeps its old tip.
- [ ] A generated Branch collision follows the same rule and does not gain a numeric suffix.
- [ ] `ask` requires confirmation before Branch creation; `deny` leaves the repository unchanged.
- [ ] Cancellation and command failure produce a bounded setup failure and no false `ready` state.
- [ ] Repository Recipes and retry checkpoints remain correct.
- [ ] `bun run check` passes.

## Validation

- Provisioner tests with two worktrees from one temporary clone and an unpushed commit selected from the Source worktree.
- Rejection test for a Source checkout from a separate clone.
- Branch-tip assertions before and after conflict, deny, timeout, and cancellation cases.
- Topic Service confirmation tests for Start Point creation.
- Existing provisioner and Recipe tests.
- Full harness.

## Comments
