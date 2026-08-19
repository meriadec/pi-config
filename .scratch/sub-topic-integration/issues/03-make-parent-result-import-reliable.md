# 03 — Make parent Delegation Result import reliable

Status: ready-for-agent
Type: bug
Blocked by: 01
Affected extension: `sub`

## Context

Parent-side mailbox polling, state reconstruction, result truncation, durable import records, and follow-up delivery are coupled in `agent/extensions/sub/index.ts`. The current tests cover message cleanup and result truncation, but they do not drive the full result import path.

A child session resumed without `PI_SUB_*` has also been observed importing its own result. Issue 01 removes the identity path that caused that resume, but the mailbox coordinator must still enforce exact parent ownership.

## Scope

- Extract a focused parent mailbox coordinator from `sub/index.ts`. Keep timer, filesystem, session, and clock dependencies injectable for fast deterministic tests.
- Record the exact parent session identity in the durable Delegation Job record. Support old records conservatively without letting a known child import its own result.
- Import a completed result only into its recorded parent session.
- Keep import idempotent by Delegation Job ID across duplicate polls, reload, and session resume.
- Preserve delivery behavior:
  - idle parent: trigger the handoff turn immediately;
  - active parent: queue one follow-up and start it when the Main Agent settles.
- Do not mark a result imported until the durable import entry and custom follow-up have both been accepted by Pi.
- Keep polling after transient mailbox read errors. Report bounded diagnostics instead of silently swallowing every error.
- Stop all timers in `session_shutdown` and when a job is imported.
- Continue to cap the Delegation Result sent to model context and retain the path to the full result.

## Acceptance criteria

- [ ] A completed result reaches the exact parent session once.
- [ ] An active Main Agent receives exactly one queued follow-up after it settles.
- [ ] Reload before and after result creation does not lose or duplicate the result.
- [ ] A transient read failure is retried and has a bounded diagnostic.
- [ ] A child session cannot reconstruct a parent watcher or import its own result.
- [ ] A different fork or resumed session does not claim a job owned by another parent session.
- [ ] Answered Delegation Results continue to leave model context as they do today.
- [ ] Coordinator tests use fake timers and a temporary mailbox; no real Kitty or model is required.
- [ ] `bun run check` passes.

## Validation

- Add red-capable tests for idle delivery, active-turn follow-up delivery, reload, duplicate polling, wrong-session ownership, and child self-import.
- Full harness.

## Comments
