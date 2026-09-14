# Build the RPC client and systemd runtime

Status: ready-for-agent

Depends on: 01, 17

Suggested commit: `refactor(work): add managed RPC client runtime`

## Read first

- `../PRD.md`, especially Compatibility, Dashboard and clients, and Performance acceptance
- current `client/client.ts` and `client/systemd.ts`
- daemon compatibility tests

## Objective

Replace manual socket correlation and Promise timers with a scoped Effect RPC client, ManagedRuntime bridges, and compatible systemd control.

## Scope

1. Build the typed RPC client Layer over the private Unix socket.
2. Expose deep client operations instead of manual request construction.
3. Implement operation start plus watch or query waiting for Pi and CLI adapters.
4. Implement state subscription with revision-gap and `ResyncRequired` reconnect.
5. Build a ManagedRuntime adapter for imperative Pi and TUI callbacks.
6. Update generated systemd unit content for the new daemon and required environment.
7. Preserve best-effort GitHub credential import without putting values on disk or command lines.
8. Implement compatibility handshake, stale-daemon restart, bounded startup wait, and clear failure reporting.
9. Keep one stable client ID for retries inside a dashboard session.
10. Add real client/daemon integration tests and fake-systemd tests.
11. Measure connection and startup behavior against the baseline.

## Constraints

- Do not switch `/work`, tools, or the CLI in this issue.
- No manual pending request map, request timer, or socket listener ownership.

## Acceptance

- Reconnect recovers state and active Operation Handles.
- Incompatible daemon restart is explicit and bounded.
- Runtime disposal closes socket, streams, watches, and reconnect work.
- Credentials stay redacted.
- `bun run check` passes.

## Comments
