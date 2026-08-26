# 08 — Isolate pull request projection

Status: ready-for-agent
Type: refactor
Blocked by: 03
Affected extension: `work`

## Context

Topic Service owns pull request poll scheduling, serial iteration over Topics, observed state storage, change comparison, snapshot projection, and event emission. Pull request discovery itself is already behind `PullRequestObserver`, but the live projection is mixed with durable Topic mutation.

## Scope

- Add an internal pull request projection module that owns poll lifecycle, current observed state, immediate refresh, change detection, and projection snapshots.
- Accept a Topic source or explicit ready-Topic targets from the control-plane implementation. Keep durable Topic manifests owned elsewhere.
- Keep `PullRequestObserver` as the true-external GitHub adapter.
- Preserve the current poll interval, immediate startup refresh, forced refresh command, known pull request reuse, and bounded failure behavior.
- Emit semantic pull request changes through the control-plane event interface.
- Ensure start and stop lifecycle cleans up timers exactly once.
- Remove pull request maps and timers from Topic Service.
- Test the projection through snapshots and events; use direct tests for timer cleanup and observer call scheduling.

## Acceptance criteria

- [ ] Topic Service no longer stores the pull request map or poll timer.
- [ ] Only ready Topics with a Worktree are sent to the observer.
- [ ] Equal observations emit no duplicate event.
- [ ] A disappeared pull request removes it from the projection and emits one null change.
- [ ] Forced refresh waits for the current refresh operation and produces an updated snapshot.
- [ ] Observer failure does not crash the daemon or expose raw `gh` output.
- [ ] Stop clears every projection timer and no later poll runs.
- [ ] Dashboard PR status and browser-open behavior remain unchanged.
- [ ] `bun run check` passes.

## Validation

- Projection tests with an in-memory observer adapter and fake timer.
- Control-plane snapshot and event integration tests.
- Dashboard forced-refresh and PR rendering tests.
- Full harness.

## Comments
