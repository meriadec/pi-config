# Build guarded rebase and observation workers

Status: ready-for-agent

Depends on: 07, 08, 09, 10, 11, 12, 14

Suggested commit: `feat(work): supervise Git and pull request observation`

## Read first

- `../PRD.md`, especially Rebase exception, Daemon lifecycle, and Observation
- ADR-0002
- current Integration Status, Worktree state, pull request polling, and rebase workflows

## Objective

Implement non-overlapping Effect workers for local and GitHub observation, plus the explicit guarded Topic rebase action.

## Scope

1. Implement local Worktree presence and Git Operation State observation every 30 seconds after the previous pass.
2. Implement Integration Status observation on startup background refresh, explicit refresh, chain changes, and rebase completion.
3. Implement pull request observation every 60 seconds after the previous pass.
4. Preserve single-flight explicit refresh behavior and bounded concurrency.
5. Use bounded exponential retry with jitter for transient GitHub failures.
6. Make readiness independent of Git and GitHub completion; publish freshness states progressively.
7. Revalidate every ADR-0002 rebase guard immediately before execution.
8. Hold the repository mutation key during daemon-owned rebase.
9. Record active rebase supervision, but never restart a rebase after daemon interruption.
10. After any outcome, inspect real Git state and publish it.
11. Use `TestClock` for schedule and no-overlap tests, plus real Git tests for conflicts and interrupted operations.
12. Add daily backup scheduling after durable state changed, without overlap.

## Acceptance

- No observation pass overlaps its own kind.
- One repository failure does not fail the full pass.
- A slow or failed GitHub call does not block local state or readiness.
- Rebase behavior still follows ADR-0002 and leaves stopped conflicts for human recovery.
- Every worker belongs to daemon Scope.
- `bun run check` passes.

## Comments
