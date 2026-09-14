# Complete final hardening and acceptance

Status: needs-info

Depends on: 26

Suggested commit: `chore(work): complete Effect migration hardening`

## Read first

- `../PRD.md`, especially Architecture enforcement, Test strategy, Performance, and Completion
- all accepted ADRs for Work
- final production dependency graph

## Objective

Prove that the final Work control plane meets its lifecycle, robustness, performance, security, and documentation commitments.

## Scope

1. Promote this issue to `ready-for-agent` only after issue 26 is complete.
2. Run and strengthen architecture checks for dependency direction and capability ownership.
3. Run lifecycle tests for daemon shutdown, dashboard disposal, Topic Agent shutdown, RPC overflow, revision gaps, operation reconnect, and process descendants.
4. Run failure-injection tests for SQLite transactions, schema migration, backup, restore, operation checkpoints, and post-commit projection rebuild.
5. Run real Git tests for Branch movement races, rebase interruption, and Worktree recovery.
6. Run TestClock tests for polls, retries, lease expiry, confirmation expiry, and retention.
7. Compare Pi import, daemon startup, dashboard open, idle work, and memory behavior with the baseline.
8. Investigate every material regression. Record accepted differences with measurements.
9. Audit logs, errors, snapshots, database rows, and backups for raw capabilities, credentials, Setup command text, session content, and unrestricted process output.
10. Update `agent/extensions/work/README.md`, operation and storage recovery instructions, package metadata, and diagrams.
11. Run a final code review against Standards and this PRD.
12. Run `bun run check` from a clean working tree.

## Completion

- Every PRD completion condition has evidence.
- No unmanaged long-lived resource remains.
- No obsolete compatibility code remains.
- Performance comparison is recorded.
- Documentation matches production behavior.
- All checks pass.

## Comments
