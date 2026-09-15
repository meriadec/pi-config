# Build the scoped process executor

Status: done

Depends on: 01, 02

Suggested commit: `refactor(work): adopt scoped Effect processes`

## Read first

- `../PRD.md`, especially Process executor and Error policy
- `agent/extensions/work/daemon/process-runner.ts`
- process use in systemd, Git, GitHub, desktop, and Topic creation
- Effect v4 `ChildProcess` and `ChildProcessSpawner` docs and contract tests from issue 01

## Objective

Replace the custom process runner with one deep Effect process module backed by `effect/unstable/process` and the Bun platform Layer.

## Scope

1. Define semantic command input and a bounded result with status, exit code, stdout, stderr, and truncation.
2. Enforce one combined byte limit across stdout and stderr.
3. Tie each process and process group to Scope.
4. Implement deadline and interruption behavior with bounded `SIGTERM` then `SIGKILL` cleanup.
5. Await process-group exit before release completes.
6. Support exact environment additions and removals, including repository-local Git variables.
7. Keep shell execution explicit and limited to Repository Recipe commands.
8. Map platform failures to typed process errors with safe messages and internal causes.
9. Add real tests for spawn failure, timeout, cancellation, descendant cleanup, ignored signals, unread output, output truncation, and environment filtering.
10. Replace current production process calls through temporary adapters where needed, then delete `LocalProcessRunner` when no caller remains.

## Acceptance

- No direct `node:child_process` remains outside an approved platform adapter.
- Process timeout and cancellation leave no descendant.
- Captured output cannot exceed its configured bound.
- No unrestricted process output enters errors or logs.
- Existing Git environment behavior remains.
- `bun run check` passes.

## Comments
