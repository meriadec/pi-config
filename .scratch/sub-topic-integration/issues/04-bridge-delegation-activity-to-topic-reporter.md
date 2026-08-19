# 04 — Bridge Delegation Job activity to the Topic Agent reporter

Status: ready-for-agent
Type: feature
Blocked by: 02
Affected extensions: `sub`, `work`

## Context

After issue 01, the child correctly has no connection to `workd`. The parent must report Delegation Job activity without exposing mailbox details to the control plane.

Pi's extension event bus is the local integration seam. The `sub` extension owns Job Mailbox reconstruction. `TopicAgentReporter` owns Main Agent activity precedence and reconnect behavior.

## Scope

- Define a small versioned semantic event contract for parent-visible Delegation Job activity. It must carry only the aggregate state needed by another extension, not prompts, results, paths, or child transcript data.
- Publish aggregate activity from the parent `sub` extension:
  - active when at least one owned Delegation Job is `created`, `launched`, or `thinking`;
  - inactive when no owned Delegation Job is active;
  - reconstruct and publish the correct aggregate after session start or reload.
- Support multiple concurrent Delegation Jobs. One completed or waiting job must not clear activity while another job is active.
- Subscribe from the Topic Agent integration and add Delegation Job activity to `TopicAgentReporter` precedence.
- Main Agent `thinking` must override Delegation Job activity. When the Main Agent settles, active Delegation Job work must become visible again.
- `tracking-pr` must return only when neither the Main Agent nor a Delegation Job is actively thinking.
- Re-assert the effective state after a `workd` reconnect.
- Stop the event subscription during `session_shutdown`.
- Ordinary Pi sessions can publish the event, but they must not connect to `workd` without a valid Topic Agent environment.

## Acceptance criteria

- [ ] Starting the first active Delegation Job reports effective `thinking-sub` from the parent reporter.
- [ ] Starting or completing additional jobs keeps correct aggregate activity.
- [ ] A Main Agent turn temporarily reports `thinking`, then restores `thinking-sub` if child work remains active.
- [ ] Tracking PR has lower precedence than Main Agent and Delegation Job thinking.
- [ ] A waiting or completed Delegation Job does not report `thinking-sub`.
- [ ] Reload reconstructs aggregate activity from the Job Mailbox.
- [ ] Reconnect re-asserts the effective state instead of resetting the Topic to idle.
- [ ] Tests cover precedence, multiple jobs, reload, and reconnect.
- [ ] `bun run check` passes.

## Validation

- Event-contract unit tests in `sub`.
- Reporter lifecycle tests in `work/topic-agent/reporter.test.ts`.
- Full harness.

## Comments
