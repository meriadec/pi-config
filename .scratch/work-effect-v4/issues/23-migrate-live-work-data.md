# Migrate the live Work data

Status: ready-for-human

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
