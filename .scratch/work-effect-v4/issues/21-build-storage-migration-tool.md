# Build the one-time JSON-to-SQLite migration tool

Status: done

Depends on: 02, 03, 04, 05, 06, 20

Suggested commit: `feat(work): add verified SQLite migration tool`

## Read first

- `../PRD.md`, especially Existing-data migration
- ADR-0004 and ADR-0006
- old Topic, affiliation, and legacy migration stores
- new storage backup and verification interfaces

## Objective

Build a temporary, explicit migration command that preserves all valid live Work data and refuses ambiguous or invalid input.

## Scope

1. Add temporary `pi-work storage migrate --dry-run` and confirmed apply modes.
2. Require the daemon lifetime lock to be free.
3. Read old configuration, Topic manifests, affiliations, and migration journals only inside an isolated migration package.
4. Require old migration journals to be settled.
5. Detect unresolved Legacy name hierarchies and stop with exact repair guidance; do not implement permanent name inference in the new application.
6. Validate every old record before writing.
7. Migrate configuration to the strict version. Treat an existing `integrationBranch` value as a configured override.
8. Create and verify a private pre-import backup of all durable source data. Replace raw capabilities in the backup with hashes or redacted records.
9. Build a temporary SQLite database, import all durable fields, hash capabilities, and verify all SQL and domain invariants.
10. Compare source and destination counts and canonical semantic records.
11. Atomically install `work.db` only after full verification.
12. Write a migration receipt with checksums, counts, schema versions, and timestamp.
13. Make rerun behavior idempotent and refuse conflicting completed receipts.
14. Add fixture migrations for every historical manifest shape and injected failure point.

## Safety

- Any invalid or ambiguous Topic blocks the complete migration.
- No Topic is skipped.
- No Branch, Worktree, repository, Pi session, or open window is changed.
- Tests use copies. This issue does not access live `~/work`.

## Acceptance

- Dry run performs all validation without installing a database or rewriting configuration.
- Apply either installs one verified database and strict config or leaves the source unchanged.
- The report contains enough bounded data for the human checkpoint.
- Old-format reading is isolated so issue 26 can delete it completely.
- `bun run check` passes.

## Comments
