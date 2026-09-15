# Build the Work state projection and stream

Status: done

Depends on: 02, 04, 10

Suggested commit: `feat(work): add revisioned Work state projection`

## Read first

- `../PRD.md`, especially Observed state, Write and publication order, and State stream
- current Topic Service snapshot and event types
- current dashboard hydration and event reduction

## Objective

Create one immutable in-memory Work projection and one bounded snapshot-first subscription interface.

## Scope

1. Define the durable and observed fields in one Work snapshot schema.
2. Represent observation freshness explicitly as unknown, refreshing, fresh, or failed where useful.
3. Implement one serialized reducer for committed durable changes and observed changes.
4. Increment a daemon-local revision with each published change.
5. Provide an immutable snapshot read.
6. Provide a snapshot-first stream with bounded per-subscriber queues.
7. Ensure a slow subscriber cannot block a state update.
8. On overflow, emit `ResyncRequired` when possible and close the subscription.
9. Detect revision gaps in a test consumer and require resubscription.
10. Reuse or adapt the existing pure dashboard reducer semantics without importing TUI code.
11. Add concurrency tests for commit order, observed updates, overflow, resync, and subscriber release.

## Constraints

- Durable state enters only after a successful repository commit.
- This module does not write SQLite.
- This module does not run Git, GitHub, or desktop processes.

## Acceptance

- One snapshot cannot combine pre-commit and post-commit durable rows.
- Event publication is bounded and non-blocking for state writers.
- Closed subscribers retain no queue or callback.
- Revision and daemon identity support reconnect resynchronization.
- `bun run check` passes.

## Comments
