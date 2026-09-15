# Build operation and capability storage

Status: done

Depends on: 02, 04

Suggested commit: `feat(work): persist operations and capability hashes`

## Read first

- `../PRD.md`, especially Durable Operation lifecycle, Confirmation and capabilities, and Retention
- current request deduplication and confirmation code in `daemon/topic-service.ts`
- current affiliation and Main Agent registration storage

## Objective

Add deep repositories for Durable Operations, Atomic Command results, confirmations, and Private local capability hashes.

## Scope

1. Extend checked-in SQL migrations with normalized operation, step, command-result, confirmation, and capability tables.
2. Store operation input and terminal result only through bounded versioned Effect Schemas.
3. Implement atomic claim by `(client ID, request ID, fingerprint)`:
   - same fingerprint returns the existing operation or result
   - different fingerprint returns a typed conflict
4. Implement operation transitions with expected current state and row revision.
5. Implement durable Setup step checkpoints and detection of a command that was running when supervision ended.
6. Store only strong hashes of confirmation, registration, and affiliation capabilities.
7. Implement one-use confirmation consumption and expiry.
8. Implement terminal result pruning at 30 days and 10,000 records without touching active operations.
9. Add repository tests with restart, collision, expiry, retention, and injected transaction failure cases.

## Security

Raw capability values must not appear in database rows, snapshots, logs, errors, or ordinary test fixtures. Tests can use fixed safe values and compare hashes.

## Acceptance

- Operation identity and result replay survive a new repository and runtime instance.
- An operation transition cannot skip an invalid state.
- Interrupted running Setup steps are distinguishable from completed steps.
- Capabilities are verified without storing raw values.
- Retention is bounded and deterministic with an injected clock.
- `bun run check` passes.

## Comments
