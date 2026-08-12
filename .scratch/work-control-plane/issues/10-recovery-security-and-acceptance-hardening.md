# Harden recovery, security, and version 1 acceptance

Status: done

## Context

Read the PRD and issues 01-09. This is the final version 1 issue. Do not expand scope into the deferred lifecycle features.

## Objective

Exercise the complete control plane under restart and failure, close resource and security gaps, and document local operation.

## Scope

Recovery and reconciliation:

- On daemon restart, reconcile provisioning checkpoints, base checkout identity, stored worktree paths, i3 marks, and main-agent heartbeats.
- Never report a disconnected agent as live merely because a manifest has a session ID.
- Reconnect dashboard subscriptions with bounded backoff and refresh from a snapshot before applying new events.
- Make daemon event sequence/revision handling explicit so a reconnect cannot apply stale state over a newer snapshot.
- Ensure repeated `/work` opens and Pi `/reload` do not duplicate commands, sockets, timers, or subscriptions.

Security and bounds:

- Verify private permissions for `~/work`, topic manifests, registration tokens, and the Unix socket where applicable.
- Confirm same-user socket assumptions and reject unsafe paths or symlink attacks during writes.
- Audit every subprocess for argument arrays, timeout/cancellation, output limits, and concise error mapping.
- Redact credentials, environment secrets, registration tokens, and Pi session content from logs and protocol errors.
- Confirm action policy is checked at the daemon side immediately before every side effect.
- Add upper bounds for topic count rendered at once, protocol frame size, diagnostics, and retained live operation messages. The UI can paginate/scroll rather than put unbounded data in one render.

Acceptance tests:

Create an integration harness with temporary storage, a temporary socket, fake `gh`/`wt`/i3/kitty/systemd/Pi adapters, and deterministic time. Cover the complete PRD scenario, including:

1. Missing config and `WORK_BASE` setup.
2. Topic creation with clone and the path returned by fake `wt`.
3. Dashboard live transition to ready.
4. Terminal allocation on the lowest empty workspace.
5. Main-agent launch, thinking, and waiting-for-human.
6. Dashboard close/reopen with daemon still alive.
7. Daemon restart and state reconciliation.
8. Workspace pool exhaustion as informational.
9. Interrupted provisioning and successful retry.
10. Clean shutdown with no leaked resources.

Documentation:

- Add a concise README under `agent/extensions/work/` with architecture, prerequisites (`bun`, `systemd --user`, `gh`, `wt`, `i3-msg`, kitty, Pi), `/work` usage, storage paths, service commands, and troubleshooting.
- Document `systemctl --user status pi-workd`, `journalctl --user -u pi-workd`, restart, and safe uninstall of only the service unit/socket. Do not suggest deleting repositories or worktrees.
- State all version 1 non-goals and deferred areas.
- Note that `/reload` is required after extension development changes.

## Validation

Run:

```text
bun run check
```

Also inspect `git status` for generated runtime files. Tests must not leave service units, sockets, `~/work` data, processes, or timers on the developer machine.

## Acceptance criteria

- The complete fake-adapter acceptance scenario passes.
- Restart and reconnect behavior cannot regress state or duplicate side effects.
- Security-sensitive data and unbounded output do not enter logs, protocol responses, or topic files.
- Operator documentation is sufficient to start, inspect, restart, and troubleshoot `workd`.
- No deferred PR/GitHub/lifecycle automation was added.
- The repository harness passes.

## Dependencies

- Issue 09

## Comments
