# Restore live dashboard status feedback

Status: done

## Parent

`../PRD.md`

## What to build

Restore useful live Work state from observation and Durable Operation updates through projection to the Topic list and details. Reconnect must keep stale data visible while clearly showing that it is stale, and every diagnostic must stay bounded.

## Acceptance criteria

- [ ] A stream failure with an existing snapshot keeps Topics visible and shows reconnecting or synchronizing status until a new snapshot arrives.
- [ ] Observation freshness and failed observation diagnostics are visible without discarding the last useful value.
- [ ] Orphan Topics are bright red and show `orphan` in Setup.
- [ ] Rebase, merge, cherry-pick, and revert state preserves pending versus conflict detail and renders it in bright red.
- [ ] Details include Base checkout, Worktree, workspace, Setup or active command detail, Git operation, Main Agent, and bounded diagnostic.
- [ ] Active Durable Operation updates and per-Topic submissions are visible; completed updates settle without leaving stale busy state.
- [ ] Interrupted Setup is explicit and leads to the Retry Setup path.
- [ ] Large or repeated diagnostics and operation updates remain bounded.
- [ ] Public observation, projection, reconnect, operation-watch, rendering, and cleanup tests cover the complete path.
- [ ] The root harness passes.

## Blocked by

- `11-restore-integration-status-and-ordering.md`
