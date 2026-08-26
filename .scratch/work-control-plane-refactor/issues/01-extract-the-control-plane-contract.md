# 01 — Extract the control-plane contract

Status: ready-for-agent
Type: refactor
Blocked by: none
Affected extension: `work`

## Context

`client/client.ts` imports protocol and result types from daemon files. `daemon/protocol.ts` imports event and snapshot types from Topic Service and Main Agent implementations. The Unix socket is a real seam, but its interface is owned by one adapter and depends on implementation details.

## Scope

- Create a neutral control-plane contract module owned by neither `client/` nor `daemon/`.
- Move all wire command, result, event, snapshot, error-detail, protocol-version, and bounded-frame types to that module.
- Move NDJSON framing and request parsing beside the contract, with no behavior change.
- Give wire data contract-owned names. Desktop, Topic Service, and Main Agent implementations can use or adapt those types, but the contract cannot import their files.
- Move `ProcessRunner` and `LocalProcessRunner` from `daemon/` to a neutral platform module because both client and daemon behavior use them.
- Update production and test imports to follow the new direction.
- Keep encoded version 12 messages byte-compatible. Do not bump the protocol version for file moves or type ownership changes.
- Add a focused import-direction check that rejects production imports from `client/` to `daemon/` and from `daemon/` to `client/`. Allow tests to assemble adapters across the seam.

## Acceptance criteria

- [ ] No production file under `client/` imports a production file under `daemon/`.
- [ ] No production file under `daemon/` imports a production file under `client/`.
- [ ] The control-plane contract imports no client, daemon, TUI, systemd, persistence adapter, or external-command implementation.
- [ ] Every current request, result, event, snapshot, and failure detail has one contract-owned type.
- [ ] Existing version 12 request and response fixtures encode without byte changes.
- [ ] Topic creation, dashboard, and Topic Agent integration tests still pass through the socket.
- [ ] The import-direction check runs in `bun run check`.
- [ ] `bun run check` passes.

## Validation

- Protocol fixture tests before and after the move.
- Import-direction test against production TypeScript files.
- Full harness.

## Comments
