# Build the Effect dashboard runtime

Status: done

Depends on: 11, 14, 15, 17, 18

Suggested commit: `refactor(work): supervise the dashboard with Effect`

## Read first

- `../PRD.md`, especially Dashboard and clients and Product compatibility
- current dashboard reducer, renderer, component, and tests
- new state stream and RPC client interfaces

## Objective

Preserve the dashboard experience while replacing manual connection, reconnect, mutation, operation-watch, and shimmer lifecycle code with one per-view ManagedRuntime.

## Scope

1. Keep dashboard state reduction, input handling, layout, and rendering pure.
2. Split the large dashboard module only along cohesive interfaces that reduce caller knowledge.
3. Create one scoped driver for connection, snapshot-first subscription, reconnect, explicit refresh, mutations, and Operation Handle watches.
4. Replace manual reconnect and shimmer timers with Effect schedules and supervised fibers.
5. Keep Partition keypress order and stable command request identities.
6. Add **Cancel Setup** with direct confirmation for active provisioning.
7. Add **Reset Integration Branch** and show configured versus inferred source.
8. Show observation freshness and Interrupted Setup clearly.
9. Preserve all current keys, ordering, columns, action availability, details, and confirmation behavior except removed Legacy controls.
10. Remove Legacy name hierarchy rendering and migration UI from the new dashboard.
11. Ensure disposal closes the ManagedRuntime and all owned work.
12. Port tests to the pure interfaces and scoped driver; delete tests that only assert deleted timer internals.

## Constraints

- Do not activate the new production extension entry yet.
- An idle dashboard has no render loop.

## Acceptance

- Existing non-Legacy dashboard behavior remains.
- Stream overflow and revision gaps produce a clean resubscription.
- Reconnect resumes active operation watches without replaying commands.
- Escape and session shutdown release all resources.
- `bun run check` passes.

## Comments
