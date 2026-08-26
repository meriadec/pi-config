# 06 — Extract request coordination

Status: ready-for-agent
Type: refactor
Blocked by: 03
Affected extension: `work`

## Context

Topic Service directly owns request deduplication, per-Topic queues, repository-and-Branch creation queues, fingerprints, result retention, and queue cleanup. These rules are substantial control-plane behavior, but they are mixed with Topic mutation and provisioning code.

## Scope

- Create an internal request-coordination module owned by the daemon control-plane implementation.
- Move client/request deduplication, fingerprint conflict detection, bounded result retention, per-Topic serialization, and repository-and-Branch creation serialization behind its interface.
- Preserve current concurrency: independent Topics can run concurrently, while conflicting operations serialize.
- Preserve reconnect semantics: the same client ID and request ID returns the same operation result; different input returns `request-id-conflict`.
- Keep queue keys and fingerprints internal. Presentation and transport adapters must not know them.
- Inject time or limits only where a current behavior or deterministic test needs it.
- Test observable behavior through control-plane command execution. Add direct coordinator tests only for failure modes that cannot be observed reliably through that interface.
- Remove replaced queue and deduplication code from Topic Service.

## Acceptance criteria

- [ ] Topic Service no longer stores request-deduplication, Topic-queue, or creation-queue maps directly.
- [ ] Independent Topic commands can overlap.
- [ ] Concurrent creation for one repository and Branch creates exactly one Topic.
- [ ] A repeated request returns the original result without a second side effect.
- [ ] Reusing a request ID with different command data returns `request-id-conflict`.
- [ ] Retained request results stay bounded at the existing limit or a documented equivalent.
- [ ] Queue entries are removed after success and failure.
- [ ] `bun run check` passes.

## Validation

- Control-plane concurrency and deduplication integration tests.
- Failure and cleanup tests.
- Existing dashboard reconnect and Topic creation conflict tests.
- Full harness.

## Comments
