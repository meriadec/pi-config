# Build the work domain and persistence foundation

Status: done

## Context

Read `.scratch/work-control-plane/PRD.md` first. This is the first implementation issue. It must create reusable domain and persistence modules without registering `/work` or starting a daemon.

## Objective

Define the versioned configuration, topic manifest, state, action-policy, and filesystem contracts. Make malformed local data safe to diagnose and make all writes atomic.

## Scope

Create deep modules below `agent/extensions/work/shared/` for:

- Domain types and runtime validation for `WorkConfig`, `TopicManifest`, setup state, main-agent state, repository reference, and action policy.
- Paths rooted at an injected home/runtime location for tests. Production defaults are `~/work/config.json`, `~/work/topics/<topic-id>/topic.json`, and `$XDG_RUNTIME_DIR/pi-workd.sock`.
- Generated opaque topic IDs. Use a format that can also be a Pi `--session-id`.
- Repository parsing for exact `owner/repo` input.
- Policy lookup in this order: topic override, repository override, global default. Return both the policy and its source.
- Atomic JSON writes: create parent directory, write a same-directory temporary file with private permissions, fsync/close as appropriate, and rename.
- Configuration load/save that preserves unknown fields during normal read-modify-write updates.
- Topic repository operations: list valid topics, load one, create one without overwrite, and update one with an `updatedAt` change.
- Per-topic serialization so concurrent writes cannot lose updates.
- Bounded diagnostics for corrupt or unsupported files. One corrupt topic must not block hydration of other topics.

Define action IDs as stable strings. Include at least:

- `repository.clone`
- `topic.create-worktree`
- `terminal.open`
- `agent.open`
- `topic.delete`

Do not add SQLite or configuration files inside company repositories.

## Required invariants

- A topic directory name is its generated ID, not its branch.
- `worktreePath` is nullable and can only be populated from a later `wt` result.
- The same branch is allowed in different repositories.
- A duplicate repository-plus-branch is rejected with a domain error.
- Config and manifests never contain credentials or Pi conversation content.
- Error messages shown to clients are concise and bounded.

## Tests

Add Bun tests for:

- Valid and invalid config and topic JSON.
- Repository parsing.
- Policy inheritance and source reporting.
- Unknown config-field preservation.
- Atomic create/update and duplicate rejection.
- Concurrent updates to one topic.
- Hydration with valid, corrupt, and unsupported-version topic manifests together.
- Injected home and runtime paths, with no writes to the real `~/work`.

Run `bun run check`.

## Acceptance criteria

- Shared modules expose a small typed interface; callers do not perform raw JSON reads or writes.
- Tests prove the invariants above.
- No extension is auto-started and no external process is executed.
- The repository harness passes.

## Dependencies

None.

## Comments
