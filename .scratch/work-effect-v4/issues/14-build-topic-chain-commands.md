# Build Topic and Integration Chain commands

Status: ready-for-agent

Depends on: 03, 04, 08, 10, 11, 12, 13

Suggested commit: `feat(work): implement transactional Topic commands`

## Read first

- `../PRD.md`, especially Database invariants, Concurrency, and Git revalidation
- ADR-0001 and ADR-0006
- pure Integration Chain and Partition modules and their tests
- current rename, Note, Partition, child activation, chain maintenance, and delete behavior

## Objective

Move all short Topic metadata mutations into typed Atomic Commands backed by one SQLite transaction and one state publication.

## Scope

1. Implement rename and Topic Note updates.
2. Implement complete-family Partition movement.
3. Implement Change Parent, Remove Parent, Move in Integration Chain, and Reset Integration Target.
4. Implement pending-child activation after provisioning.
5. Implement Topic deletion with chain repair and restricted Parent deletion.
6. Implement inferred Integration Branch storage, configured override precedence, and Reset Integration Branch.
7. Use keyed family and repository locks plus expected Topic row revisions.
8. For Git-derived plans, read exact tips before and after planning and reject movement.
9. Commit each accepted multi-Topic plan in one repository transaction.
10. Publish only the committed result through the state reducer.
11. Remove Legacy name hierarchy planning from new application code.
12. Port concurrent, restart, rollback, and real ancestry tests to deep command interfaces.

## Non-goals

- rebase execution
- legacy family migration
- UI changes

## Acceptance

- Every Atomic Command is replay-safe across daemon restart.
- Injected failures cannot leave a partial family or Partition update.
- Graph invariants pass after every command.
- Git races and stale Topic revisions fail closed.
- No application caller assembles repository updates itself.
- `bun run check` passes.

## Comments
