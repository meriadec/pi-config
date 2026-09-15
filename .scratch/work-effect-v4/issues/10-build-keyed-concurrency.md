# Build keyed structured concurrency

Status: done

Depends on: 01, 02

Suggested commit: `feat(work): add scoped keyed concurrency`

## Read first

- `../PRD.md`, especially Concurrency
- every Promise queue in current Work stores, provisioner, Integration Branch resolver, and Topic Service

## Objective

Replace manual Promise queues with one deep keyed-concurrency module and one bounded process-permit module.

## Scope

1. Define typed lock keys for Topic, family, repository mutation, and repository-and-Branch creation.
2. Expose one `withKeys` operation that sorts and removes duplicate keys.
3. Acquire and release through Effect interruption-safe primitives and Scope.
4. Remove unused key entries after waiters and holders finish.
5. Define one global expensive-process permit module. Keep its default configurable for tests and select the live default from measured behavior.
6. Test:
   - same-key serialization
   - independent-key concurrency
   - sorted multi-key deadlock prevention
   - waiting-fiber interruption
   - holder interruption and release
   - no stale key retention
   - process permit bounds
7. Move no domain logic into this module.

## Interface rule

Callers know semantic keys and the protected Effect. They do not know Semaphore, map, waiter, or release implementation details.

## Acceptance

- No new Promise queue exists in migrated code.
- Lock release is correct for success, expected failure, defect, timeout, and interruption.
- Tests use deterministic latches, not timing guesses.
- The module has a small interface and no application policy.
- `bun run check` passes.

## Comments
