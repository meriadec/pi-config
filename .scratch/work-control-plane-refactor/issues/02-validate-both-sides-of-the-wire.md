# 02 — Validate both sides of the wire

Status: ready-for-agent
Type: refactor
Blocked by: 01
Affected extension: `work`

## Context

The daemon strictly parses client requests, but `WorkClient` parses only the response envelope. Successful `result` values are `unknown` values cast to expected TypeScript types. Events are accepted after a shallow type-name check. A matching protocol version therefore does not prove that server data satisfies the control-plane contract.

## Scope

- Add strict, bounded codecs for all server response, event, subscription snapshot, daemon snapshot, operation, Main Agent lease, Topic mutation, and desktop Action result variants.
- Correlate a response with the pending command so its result codec is selected from the command, not guessed from the payload.
- Store the pending command identity with each pending client request.
- Reject malformed successful results, malformed errors, malformed revisions, unknown event fields, and oversized bounded strings with a clear client protocol error.
- Keep forward-compatibility rules explicit. Use exact keys for versioned wire records unless the contract identifies an optional compatibility field.
- Keep the current disconnect behavior for a daemon that violates the protocol.
- Keep request parsing strict and use shared validation primitives where this reduces duplication.
- Preserve the protocol version if valid version 12 messages do not change.

## Acceptance criteria

- [ ] No successful socket result enters client code through an unchecked `as Promise<...>` cast.
- [ ] Every command result has a contract codec selected by command identity.
- [ ] Every event payload is fully validated before subscriber delivery.
- [ ] Invalid nested Topic, operation, pull request, Main Agent, and Action result data is rejected.
- [ ] Optional compatibility fields have named tests for presence and absence.
- [ ] A malformed server frame fails pending requests and disconnects once with a bounded error.
- [ ] Valid current daemon messages remain compatible.
- [ ] `bun run check` passes.

## Validation

- Table-driven codec tests for every command and event variant.
- Negative tests that corrupt one nested field at a time.
- End-to-end client and daemon tests over a temporary Unix socket.
- Full harness.

## Comments
