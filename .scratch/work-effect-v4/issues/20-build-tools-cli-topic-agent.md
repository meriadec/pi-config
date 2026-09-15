# Build tools, CLI, and Topic Agent adapters

Status: done

Depends on: 03, 06, 13, 16, 17, 18, 19

Suggested commit: `refactor(work): adapt tools and CLI to Effect RPC`

## Read first

- `../PRD.md`, especially Product compatibility and Dashboard and clients
- current tool, CLI, Topic Agent reporter, command registration, and `sub` integration code

## Objective

Build thin Promise adapters for Pi and executable callbacks while all real work runs through scoped Effect programs and Operation Handles.

## Scope

1. Preserve `work_topic_create` and `work_topic_create_child` names and parameter meanings.
2. Resolve Source checkout and Start Point through the new Git interface.
3. Start a Durable Operation, watch it, and return the current semantic result.
4. Tool cancellation stops waiting and closes its runtime; it does not cancel the operation.
5. Preserve direct human confirmation and headless confirmation-required behavior.
6. Preserve `pi-work topic create` and `create-child`, with a new explicit CLI JSON version where needed.
7. Add operation list, show, and confirmed cancel commands.
8. Add storage backup, verify, and explicit restore commands. Restore refuses while the daemon lock is held.
9. Replace Topic Agent heartbeat and reconnect with one scoped retry schedule that continues after repeated daemon outages.
10. Reassert effective activity after each registration.
11. Keep Topic Agent runtime lazy and disabled in ordinary or Delegation Job sessions.
12. Update `sub` integration only at the Work capability seam and retain environment stripping.
13. Add adapter and cross-extension tests.

## Constraints

- Pi, TUI, readline, and executable callbacks can return Promises as thin adapters.
- Do not switch the production extension or binary entry point yet.

## Acceptance

- Current tool and CLI use cases work through Operation Handles.
- Client timeout and cancellation messages distinguish waiting from daemon operation state.
- Repeated Topic Agent reconnect failures recover later without leaking concurrent reconnects.
- Ordinary Pi startup does not construct the Work runtime.
- `bun run check` passes.

## Comments
