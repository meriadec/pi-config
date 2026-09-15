# Migrate the live Work data

Status: done

Depends on: 21, 22

## Purpose

Run the verified one-time migration against the human's real Work data. This issue requires explicit access outside the repository boundary and meaningful human review. An agent must not infer approval.

## Preconditions

- Issues 01 through 22 are complete and green.
- The old production daemon and dashboard still work.
- The migration tool has passed fixture and failure-injection tests.
- The human has closed or accounted for active provisioning.

## Human procedure

1. Run the full repository harness.
2. Open the old dashboard and resolve every Legacy name hierarchy. Repair any ambiguous family explicitly.
3. Confirm no legacy migration journal is active or unsettled.
4. Run `pi-work storage migrate --dry-run` and inspect every reported count and warning.
5. Stop `pi-workd` and confirm the daemon lock is free.
6. Run the confirmed migration apply command.
7. Run `pi-work storage verify` against the installed database.
8. Compare the receipt with the source:
   - Topic count and IDs
   - repository and Branch
   - names and Notes
   - Parent and Integration Target links
   - Origin Commits and chain state
   - Partitions
   - setup checkpoints and Worktree paths
   - Main Agent session identity and file
   - Pull Request identity
9. Confirm the pre-import backup exists and verifies.
10. Append the non-secret migration receipt identity, counts, verification result, and explicit approval under Comments.

## Failure rule

Stop on any mismatch, invalid record, ambiguous family, backup failure, or verification failure. Do not skip a Topic. Do not edit SQLite by hand. Preserve the report and backup and request diagnosis.

## Completion

This issue is complete only after the human records explicit approval in Comments. Then change issue 24 from `needs-info` to `ready-for-agent`.

## Comments

- Receipt: `~/work/json-migration-receipt.json`
- Completed: `2026-09-15T14:22:24.005Z`
- Counts: 7 Topics, 7 affiliations, 1 settled Legacy migration journal
- Source checksum: `a69d4c59906812078901e23afb473656249b3633e6383591f3a0a01d86f616d2`
- Installed database checksum: `84ee47de24c03ceaa6bb2b837d14925fc03d17d6c06145d76fe6d02870c9b78b`
- Backup: `~/work/backups/json-migration-2026-09-15T14-22-24-005Z`
- Verification: backup verified; receipt, installed database, source checksum, counts, and migrated records verified
- Human approval: “I approve the live Work data migration. The receipt, counts, backup verification, installed database verification, and migrated records are correct.”
