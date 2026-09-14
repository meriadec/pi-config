# Build storage backup and verification

Status: ready-for-agent

Depends on: 03, 04, 05

Suggested commit: `feat(work): add verified storage backups`

## Read first

- `../PRD.md`, especially Backups and recovery and Database migration failure policy
- current private atomic JSON and legacy migration backup behavior

## Objective

Create a deep storage maintenance module that can back up, verify, and explicitly restore Work state without automatic destructive recovery.

## Scope

1. Define the private backup bundle format, manifest, checksums, schema versions, source identity, and completion receipt.
2. Use the SQLite client export facility for a consistent database image.
3. Include the strict configuration snapshot.
4. Preserve the complete old JSON source only in the one-time migration backup.
5. fsync files and parent directories before a backup is considered complete.
6. Verify checksums, SQLite integrity, foreign keys, row schemas, and domain graph invariants.
7. Implement explicit restore that requires the daemon lock to be free and an exact backup path.
8. Implement daily backup eligibility after durable state changed and retention of the latest 14 daily backups.
9. Never automatically restore after corruption or migration failure.
10. Add fault-injection tests for every preparation and install stage.

## Interface rule

Application callers request `backup`, `verify`, or `restore`; they do not handle SQLite export bytes, temporary paths, or receipt installation.

## Acceptance

- A failed backup never replaces a valid completed backup.
- A failed restore never replaces the current database.
- Verification detects checksum, SQLite, foreign-key, schema, and graph corruption.
- Original migration backup retention is independent of daily pruning.
- All directories and files have private modes.
- `bun run check` passes.

## Comments
