# 03 — Deepen command execution

Status: ready-for-agent
Type: refactor
Blocked by: 02
Affected extension: `work`

## Context

One Action is repeated as a protocol union member, parser branch, `WorkClient` method, dashboard client method, server switch branch, and Topic Service method. Most of these methods only pass fields through. This is a shallow interface and gives low locality for control-plane changes.

## Scope

- Define one discriminated `WorkCommand` contract and a static command-to-result type mapping.
- Reduce the external client interface to command execution, subscription, disconnect observation, and close lifecycle.
- Keep request ID, client ID, timeout, and retry identity in command execution options rather than domain command fields.
- Add a daemon-side control-plane implementation with one command execution entry point plus snapshot, subscription, start, and stop lifecycle as needed.
- Make the socket server a transport adapter: parse a request, call command execution, encode the result.
- Move command routing out of the socket server's large Action switch.
- Adapt dashboard, CLI, Pi tool, and Topic Agent callers to the command interface.
- Remove per-Action client and dashboard interfaces when they add no behavior.
- Keep convenient functions only where they hide a complete caller workflow rather than one socket request.
- Preserve command-specific result inference at compile time and runtime codec selection.

## Acceptance criteria

- [ ] A caller can execute any Work command through one typed entry point.
- [ ] Passing a command infers its exact result type without a caller cast.
- [ ] The socket server does not contain one business dispatch branch per Action.
- [ ] Request IDs remain stable when the dashboard retries after reconnect.
- [ ] Topic Agent registration and activity commands use the same interface without losing connection-affiliation behavior.
- [ ] Adding a fixture-only command requires one contract definition, one implementation branch, and its behavior tests, not synchronized client method lists.
- [ ] Existing user-visible behavior and protocol compatibility remain unchanged.
- [ ] `bun run check` passes.

## Validation

- Compile-time command/result type tests.
- Request deduplication and reconnect tests.
- Dashboard, CLI, Pi tool, and Topic Agent socket integration tests.
- Full harness.

## Comments
