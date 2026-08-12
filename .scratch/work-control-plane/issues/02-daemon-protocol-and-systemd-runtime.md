# Add the workd protocol and systemd runtime

Status: done

## Context

Read the PRD and issue 01. `workd` must outlive the Pi session that opened `/work`. Long-lived resources must not start from a Pi extension factory.

## Objective

Implement a persistent local daemon, a typed client, and an on-demand systemd user-service installer around a private Unix socket.

## Scope

Create modules below `agent/extensions/work/daemon/` and a client transport below `agent/extensions/work/client/`.

Protocol requirements:

- Versioned newline-delimited JSON over `$XDG_RUNTIME_DIR/pi-workd.sock`.
- Request IDs with exactly one success or error response.
- A `ping` request and a `snapshot` request.
- A subscription request followed by semantic daemon events.
- Maximum frame size and bounded parse errors.
- Unknown versions, message kinds, and actions fail clearly without crashing the server.
- Slow or disconnected clients cannot block daemon work.

Runtime requirements:

- A Bun executable entry point that owns the server and closes cleanly on SIGTERM/SIGINT.
- Refuse unsafe socket locations and remove only a stale socket that is owned by the current user.
- Create the socket with user-only permissions.
- Track and close clients, timers, and the server during shutdown.
- Keep daemon state independent from any Pi session.

Systemd requirements:

- Provide an installer/manager that writes `~/.config/systemd/user/pi-workd.service` with the resolved Bun executable and daemon entry path.
- Use argument-safe service content and no shell command interpolation.
- Reload the user manager after an actual unit change.
- Start the service on demand; do not enable it at login in version 1.
- Client connection flow is: try ping, install/update unit if needed, start unit, wait with a bounded deadline, then return a useful failure.
- Inject process execution and paths so tests do not call real systemd.

The initial snapshot can contain an empty topic list and daemon metadata. Do not implement provisioning in this issue.

## Tests

Add Bun tests for:

- Split and combined NDJSON frames.
- Oversized and invalid frames.
- Request/response correlation and daemon errors.
- Snapshot plus subscription event delivery.
- Client disconnect and server shutdown cleanup.
- Temporary-socket end-to-end ping.
- Stable systemd unit generation.
- No rewrite or daemon-reload when unit content is unchanged.
- Bounded startup timeout and simulated systemctl failures.

Run `bun run check`.

## Acceptance criteria

- A test client can start a temporary `workd`, ping it, get a snapshot, subscribe, and disconnect cleanly.
- Production service management is on demand and does not require root.
- No daemon starts merely because Pi discovers the extension files.
- All output and protocol frames are bounded.
- The repository harness passes.

## Dependencies

- Issue 01

## Comments
