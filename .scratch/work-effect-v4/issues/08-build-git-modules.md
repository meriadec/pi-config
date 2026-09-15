# Build deep Git modules

Status: done

Depends on: 02, 07

Suggested commit: `refactor(work): deepen Git control modules`

## Read first

- `../PRD.md`, especially Git modules and Git time-of-check versus time-of-use
- ADR-0001 and ADR-0002
- current branch ancestry, integration status, Worktree, provisioning validation, and client Start Point code

## Objective

Put Git command knowledge behind small semantic interfaces. Preserve real Git behavior and remove Git argument construction from application modules.

## Scope

1. Build interfaces for:
   - resolving a Start Point and repository identity
   - reading exact Branch tips
   - reading Branch ancestry
   - listing and validating Worktrees
   - inspecting Worktree cleanliness and Git Operation State
   - calculating Integration Status and conflict prediction
   - creating a Branch at an exact commit
   - guarded rebase
2. Use branded domain inputs and typed Git errors.
3. Use the process module for every command with clean Git environment, deadline, and output bound.
4. Preserve the configured agent Git signing behavior for rebase.
5. Add a stable-tip helper that reads all relevant tips before and after planning and rejects movement.
6. Keep pure ancestry-based Chain planning outside this module.
7. Retain real temporary-repository tests and add race tests where a Branch moves between reads.
8. Remove old Git infrastructure after callers move to the new interfaces.

## Interface rule

Application modules ask Git questions. They do not pass arbitrary argument arrays or parse command output.

## Acceptance

- Existing Start Point, ancestry, status, Worktree, and rebase scenarios pass through the new interfaces.
- Every Git process is bounded and argument-safe.
- Branch movement during a plan is detected and fails closed.
- No Git mutation occurs in observation methods.
- `bun run check` passes.

## Comments
