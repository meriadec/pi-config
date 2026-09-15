# Build SQLite Topic storage

Status: done

Depends on: 01, 02

Suggested commit: `feat(work): add transactional SQLite Topic storage`

## Read first

- `../PRD.md`, especially Persistence, Invariants, and Write and publication order
- ADR-0001, ADR-0002, and ADR-0004
- current Topic, chain, Partition, setup, and Main Agent persistence code

## Objective

Create the normalized SQLite schema and a deep Topic repository. SQLite becomes capable of storing every daemon-owned durable Topic fact without exposing SQL to application callers.

## Scope

1. Add checked-in numbered SQL migrations and storage schema versioning.
2. Add normalized tables for Topics, setup checkpoints, Topic relationships, Main Agent durable identity, inferred repository state, and storage metadata.
3. Enable foreign keys, WAL, a bounded busy timeout, private file permissions, and one scoped Effect SQL client.
4. Add row revisions for optimistic updates.
5. Define a small Topic repository interface around domain operations, not generic CRUD.
6. Include atomic operations for:
   - create a root or pending child Topic
   - update one Topic with an expected revision
   - apply a complete Chain Plan
   - update a complete family Partition arrangement
   - delete a Topic with chain repair
   - update setup checkpoints
   - update Main Agent durable identity
   - store inferred Integration Branch state
7. Decode every returned row through Effect Schema.
8. Add real temporary-SQLite tests for constraints, rollback at each multi-row write point, nested transaction behavior, and concurrent expected-revision conflicts.

## Constraints

- No ORM.
- No child process, Git, network, or event publication inside a transaction.
- No cascading Topic deletion.
- Do not import old JSON data in this issue.

## Acceptance

- The repository can represent every durable Topic field in the PRD.
- Local SQL constraints and application graph invariants are tested.
- Multi-Topic changes are atomic under injected failures.
- Raw Effect SQL does not escape the storage package.
- `bun run check` passes.

## Comments
