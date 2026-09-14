# Build the Durable Operation engine

Status: ready-for-agent

Depends on: 05, 10, 11

Suggested commit: `feat(work): add durable operation engine`

## Read first

- `../PRD.md`, especially Work classifications, Operation Handle, Durable Operation lifecycle, and Confirmation
- operation and capability storage from issue 05
- current deduplication and confirmation behavior

## Objective

Create the daemon-owned operation engine that separates accepted work from client wait lifetime.

## Scope

1. Expose start, get, watch, await, request cancellation, confirm, and reject through a small application interface.
2. Start returns an Operation Handle after durable acceptance.
3. Supervise operation fibers under the daemon scope and indexed by Operation ID.
4. Recover accepted and safely resumable operations after restart.
5. Mark a running Setup command as Interrupted Setup instead of rerunning it.
6. Implement Atomic Command idempotence through the command-result repository.
7. Implement durable-operation confirmation persistence and ephemeral in-memory confirmation support.
8. Use deadline-driven confirmation expiry and scheduled result retention with Effect time.
9. Ensure client interruption stops only its watch or await fiber.
10. Implement typed state-transition refusal and defect reporting.
11. Publish bounded semantic operation progress through Work state.
12. Add TestClock and restart tests for all states and races.

## Non-goals

- Topic provisioning steps
- RPC transport
- dashboard presentation

## Acceptance

- A client can disconnect, reconnect, and read the same operation result.
- A reused request identity cannot apply a second side effect.
- Daemon scope closure interrupts workers after persisted checkpoints.
- Confirmation is one-use, bounded, and correctly durable or ephemeral.
- No operation fiber is detached from a supervisor.
- `bun run check` passes.

## Comments
