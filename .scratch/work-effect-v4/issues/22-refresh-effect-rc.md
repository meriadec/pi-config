# Refresh and freeze the Effect v4 RC

Status: done

Depends on: 17, 18, 19, 20, 21

Suggested commit: `build(work): refresh Effect v4 release candidate`

## Read first

- `../PRD.md`, especially Dependency policy
- issue 01 contract tests
- current Effect v4 release notes and package AI docs

## Objective

Before live migration, evaluate the current Effect v4 RC as one dependency family, upgrade when appropriate, and freeze the exact validated versions.

## Scope

1. Inspect the current `rc` versions of `effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun`.
2. Review breaking changes since the pinned version for APIs used by Work.
3. Upgrade all three packages together to the same exact RC when a newer compatible RC exists.
4. Never save the moving `rc` tag in `package.json`.
5. Run focused contract tests first, then all Work tests, then the root harness.
6. Repeat daemon startup, Unix RPC, SQLite transaction, process-group cleanup, ManagedRuntime disposal, and TestClock contract checks.
7. Record the checked version, date, relevant changes, and decision in the Work engineering note at `agent/extensions/work/docs/engineering-notes.md`, even when no upgrade is needed.
8. Fix only migration-related compatibility changes in this issue.

## Acceptance

- Package versions are exact and mutually compatible.
- The decision is reproducible from the note and lockfile.
- No unrelated feature change is mixed into the upgrade.
- `bun run check` passes.

## Comments
