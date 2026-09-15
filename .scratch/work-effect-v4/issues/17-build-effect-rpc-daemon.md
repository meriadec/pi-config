# Build the Effect RPC daemon

Status: done

Depends on: 11, 12, 13, 14, 15, 16

Suggested commit: `feat(work): serve the control plane with Effect RPC`

## Read first

- `../PRD.md`, especially Effect RPC, Daemon lifecycle, State stream, and Error policy
- ADR-0005
- current protocol, server, and daemon entry code
- issue 01 RPC and socket contract tests

## Objective

Create the new scoped daemon Layer and typed Effect RPC interface over a private Unix socket with bounded NDJSON.

## Scope

1. Define one RPC group for compatibility, snapshots, state subscription, operation start/get/watch/cancel/confirm/reject, Atomic Commands, Main Agent calls, and Ephemeral Actions.
2. Define every payload, success, expected error, and stream item with Effect Schema.
3. Use bounded NDJSON serialization with an explicit maximum frame and parser buffer.
4. Implement snapshot-first revisioned state subscription and `ResyncRequired` handling.
5. Isolate request defects so one defect does not stop unrelated requests or streams.
6. Add the compatibility handshake with application protocol, storage schema, build, start identity, and starting/ready state.
7. Acquire a private lifetime daemon lock before storage work.
8. Validate stale socket type, owner, location, and listener before removal.
9. Set the socket to mode 0600 and keep runtime directory assumptions explicit.
10. Compose storage, application, observation, process, desktop, and RPC Layers into a new daemon program.
11. Implement bounded graceful shutdown in the PRD order.
12. Add real Unix socket tests for framing bounds, stream overflow, reconnect, readiness, request defects, singleton refusal, permissions, and shutdown cleanup.

## Constraints

- Do not switch the production entry point yet.
- Do not retain a manual action switch or pending-request map in the new server.

## Acceptance

- The new daemon serves the complete application through generated typed RPC clients.
- Client wait interruption does not cancel a Durable Operation.
- Slow clients do not block state changes.
- A second daemon cannot begin recovery or polling.
- Shutdown leaves no lock, socket, child process, or supervised fiber.
- `bun run check` passes.

## Comments
