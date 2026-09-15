# Build the Main Agent lifecycle module

Status: ready-for-agent

Depends on: 04, 05, 09, 10, 11

Suggested commit: `feat(work): implement scoped Main Agent leases`

## Read first

- `../PRD.md`, especially Confirmation and capabilities and Main Agent lifecycle
- current `daemon/main-agent.ts` and `topic-agent/reporter.ts`
- `agent/extensions/sub/topic-integration.test.ts`

## Objective

Replace the manual Main Agent manager with a deep Effect module that separates durable session identity from live lease observation and protects adoption with hashed capabilities.

## Scope

1. Hydrate durable Main Agent identity from SQLite and initialize observed leases as stopped.
2. Generate one-use short-lived registration capabilities and window-lifetime affiliation capabilities.
3. Store only capability hashes.
4. Implement exact launched-session registration and in-window `/new` adoption.
5. Atomically update durable session identity and file on adoption.
6. Enforce one connected Main Agent per Topic.
7. Implement reset with capability rotation before new launch.
8. Replace interval sweeping with deadline-driven heartbeat expiry.
9. Keep activity precedence: thinking, Delegated Thinking, Tracking PR, waiting.
10. Publish live lease changes through Work state.
11. Keep Pi session contents unread.
12. Add restart, expiry, adoption, cross-Topic rejection, reset, and Delegation Job isolation tests with `TestClock`.
13. Serve Main Agent registration, adoption, and reset as separate direct RPCs on this module and the state projection, not as operation-engine Atomic Commands. This module therefore does not depend on issue 12.

## Acceptance

- A surviving window reattaches after daemon restart.
- Raw capabilities are absent from SQLite, logs, errors, and state snapshots.
- Heartbeat and registration expiry need no polling interval.
- Reset and adoption preserve existing session-file behavior.
- Delegation Jobs cannot claim or alter a Topic Main Agent lease.
- `bun run check` passes.

## Comments
