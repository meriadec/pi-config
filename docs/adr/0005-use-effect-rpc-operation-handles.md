# Use Effect RPC with Operation Handles

Status: accepted

Work clients and `pi-workd` will communicate through Effect RPC over a private Unix socket with bounded NDJSON serialization. Starting long-lived work returns an Operation Handle; separate query and stream calls observe its progress and terminal result. This keeps accepted Durable Operations owned by the daemon when a client disconnects, cancels its wait, or reconnects after a daemon restart.

## Consequences

A compatibility handshake remains explicit and can restart an incompatible daemon. State subscriptions are snapshot-first, revisioned, and bounded per client; overflow or a revision gap causes resynchronization instead of blocking state changes. The Unix user and private socket are the security perimeter. Client and request identities provide durable idempotence, not multi-user authorization.
