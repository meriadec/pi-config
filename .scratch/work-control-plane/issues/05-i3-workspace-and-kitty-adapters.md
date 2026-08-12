# Add temporary i3 workspace leases and kitty terminals

Status: done

## Context

Read the PRD and issues 01-04. Workspaces `1` through `10` are a temporary pool. No available workspace is a normal result.

## Objective

Add daemon-owned desktop adapters that find topic windows, lease an empty workspace, focus a topic workspace, and launch a marked kitty terminal in the topic worktree.

## Scope

Create narrow i3 and kitty interfaces with injected process execution and clock/polling.

Workspace behavior:

- Query i3 state as JSON and inspect the tree, not only `get_workspaces`.
- Find topic windows by an i3 mark derived safely from the opaque topic ID.
- If marked windows exist, derive the topic workspace from their current tree location.
- If none exist, select the lowest workspace in `1..10` that contains no windows.
- Treat an unmaterialized numbered workspace as empty.
- If none is empty, return `{ kind: "unavailable", message: ... }`; do not throw.
- Focus an existing topic workspace for the Access Workspace action.
- Never move or replace unrelated user windows.

Kitty behavior:

- Enforce `terminal.open` policy inside the daemon.
- Require a ready topic and validated worktree path.
- Launch with `kitty --single-instance --instance-group i3` and the worktree as cwd.
- Arrange for the created OS window to receive the topic i3 mark. Use a deterministic window identity plus bounded i3 event/poll reconciliation; do not mark whichever window happens to be focused without identity verification.
- Put all later terminal windows for the topic on its existing workspace.
- Return a concise launch/focus/unavailable result.
- Use argument arrays and no shell-constructed command.

Add protocol actions and semantic events for Access Workspace and Open Terminal. Workspace numbers are observable live state, not durable ownership in `topic.json`.

## Tests

Use fixture i3 trees and fake runners. Cover:

- Existing marked topic window.
- Topic window moved to another workspace.
- Lowest empty workspace selection across `1..10`.
- Unmaterialized empty workspace.
- Full pool returns `unavailable` as success.
- Unrelated marks and windows remain untouched.
- Kitty command arguments, cwd, and identity.
- Mark reconciliation success, timeout, and ambiguous matches.
- Policy enforcement and non-ready topic rejection.
- Process output and timeout bounds.

Run `bun run check`.

## Acceptance criteria

- Topic workspace lookup follows marked windows after users move them.
- A lease ends naturally when no marked topic windows remain.
- Workspace exhaustion is clear but non-exceptional.
- The daemon is the only layer that talks to i3 or kitty.
- The repository harness passes.

## Dependencies

- Issue 04

## Comments
