# Expose topics and provisioning through workd

Status: done

## Context

Read the PRD and issues 01-03. The daemon, not the UI, owns mutations and live operation state.

## Objective

Hydrate topics at daemon startup and expose typed topic creation, retry, deletion, snapshot, and subscription operations.

## Scope

Introduce a daemon-level Topic Service that composes persistence and provisioning.

Add protocol actions for:

- Get current snapshot.
- Create a topic from name, branch, and `owner/repo`.
- Retry setup.
- Request topic deletion.
- Confirm or reject an action whose effective policy is `ask`.

Behavior:

- Hydrate every valid manifest at startup and include diagnostics for rejected manifests.
- Reconcile topics left in `provisioning`. Queue safe reconciliation without blocking daemon startup.
- Serialize mutating operations per topic while permitting independent topics to progress.
- Deduplicate repeated request IDs and prevent double side effects after a client retry.
- Emit semantic events such as topic added, setup changed, topic changed, topic removed, and diagnostic added.
- Include operation progress in snapshots without writing transient transport details into manifests.
- Return a confirmation token for `ask`. Bind it to the action, arguments, topic, client request, and a short expiry. Re-check policy and preconditions after confirmation.
- `deny` must reject inside the daemon even if a client attempts to bypass the UI.
- Delete only the local topic manifest in version 1. Do not delete branches, worktrees, base checkouts, Pi sessions, or kitty windows. Make this limitation explicit in the confirmation text.
- Do not expose raw subprocess output through protocol errors or events.

Topic validation must reject empty names, malformed repositories, invalid Git branch names, and duplicate repository-plus-branch subjects before provisioning starts.

## Tests

Add daemon/client integration tests for:

- Hydrated snapshot and corrupt-topic diagnostics.
- Topic create event sequence through ready.
- Topic create through setup-failed and retry.
- Concurrent creation of independent topics.
- Duplicate topic rejection.
- Duplicate request ID without repeated side effects.
- `allow`, `ask` confirmation, expired confirmation, and `deny` enforcement.
- Safe manifest-only deletion.
- Restart reconciliation from each setup checkpoint.

Run `bun run check`.

## Acceptance criteria

- A client can manage topics without direct filesystem or subprocess access.
- Subscribed clients receive enough semantic events to maintain a current view.
- Restart and client retry do not duplicate provisioning side effects.
- The repository harness passes.

## Dependencies

- Issue 02
- Issue 03

## Comments
