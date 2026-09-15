# Prove the Effect v4 foundation

Status: done

Depends on: none

Suggested commit: `build(work): establish Effect v4 foundation`

## Read first

- `../PRD.md`, especially Dependency policy and Performance and resource acceptance
- `package.json`, `tsconfig.json`, and the root `AGENTS.md`
- Effect v4 package AI docs and direct module declarations for every API used

## Objective

Install one exact Effect v4 RC family and prove that its required Bun integrations satisfy Work before the rewrite depends on them.

## Scope

1. Add exact runtime dependencies for `effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun`. Start with `4.0.0-rc.115` for all three.
2. Add permanent Bun contract tests for:
   - `ManagedRuntime` construction and disposal
   - `TestClock`
   - an Effect RPC round trip over a real temporary Unix socket with bounded NDJSON
   - SQLite migration, commit, rollback, foreign keys, and clean scoped close
   - child-process interruption that terminates a descendant process group
   - bounded combined process output
3. Measure direct-module import startup and root-barrel import startup. Record the baseline in the Work engineering note at `agent/extensions/work/docs/engineering-notes.md`.
4. Establish direct Effect imports as the Work convention.
5. If an upstream adapter fails a required contract, implement one minimal Effect-native adapter and record the failed contract. Do not keep two implementations.

## Constraints

- Keep Bun test.
- Do not begin product migration in this issue.
- Contract tests must use temporary paths and must clean all processes, sockets, and databases.
- A passing test must not depend on fixed sleeps when `TestClock` or a readiness signal can decide completion.

## Acceptance

- Dependencies are exact and in `dependencies`.
- The contract tests prove the selected SQL, RPC, socket, process, Scope, and clock behavior.
- Test cleanup leaves no child process or Unix socket.
- Direct module imports are documented and used.
- `bun run check` passes.

## Comments
