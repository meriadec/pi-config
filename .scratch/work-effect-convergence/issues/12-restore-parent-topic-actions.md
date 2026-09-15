# Restore Parent Topic relationship actions

Status: done

## Parent

`../PRD.md`

## What to build

Restore Change Parent Topic and Remove Parent Topic as complete metadata-only dashboard actions. Change Parent uses a bounded chooser and current Git ancestry to place the Topic in the new family. Remove Parent reconnects the old chain and makes the Topic a root against the repository Integration Branch.

## Acceptance criteria

- [ ] Change Parent appears only for Topics that can join another one-level family; Remove Parent appears only for children.
- [ ] The Parent chooser lists only valid same-repository root Topics, supports Vim and arrow movement, submits with Enter, and cancels with Escape.
- [ ] Change Parent adopts the new family Partition and inserts at the ancestry-supported position atomically.
- [ ] Remove Parent repairs the old chain, keeps the Topic Partition, and targets the Integration Branch.
- [ ] Neither action runs fetch, rebase, merge, reset, cherry-pick, or any Branch movement.
- [ ] Invalid, nested, cross-repository, ambiguous, and concurrently changed plans fail without partial metadata writes.
- [ ] Selection and updated Integration Status remain stable after success and reconnect.
- [ ] Public action, chooser, planning, atomic-write, refusal, and component tests cover both paths.
- [ ] The root harness passes.

## Blocked by

- `11-restore-integration-status-and-ordering.md`
