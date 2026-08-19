# 01 — Isolate Delegation Jobs from Topic Agent identity

Status: done
Type: bug
Blocked by: none
Affected extensions: `sub`, `work`

## Context

`launchKittyChildPi` inherits the parent process environment. In a Topic Main Agent, this includes the registration token and durable window affiliation used by `TopicAgentReporter`. The child has a different Pi session ID, so the reporter and `workd` adoption path can replace the Main Agent lease with the child session.

A Delegation Job is not an in-window `/new` session. It must not receive Topic Agent identity.

## Scope

- Add a small, testable child-environment builder in `agent/extensions/sub/launcher.ts` or a focused helper module.
- Remove all Topic Agent identity variables from the environment passed to Kitty and its child shell:
  - `PI_WORK_TOPIC_ID`
  - `PI_WORK_SOCKET`
  - `PI_WORK_REGISTRATION_TOKEN`
  - `PI_WORK_SESSION_ID`
  - `PI_WORK_AFFILIATION`
  - `PI_WORK_TOPIC_NAME`
- Preserve unrelated environment variables and the explicit `PI_SUB_*` values.
- Add a defense in depth guard so `TopicAgentReporter` is disabled when both `PI_SUB_JOB_ID` and `PI_SUB_JOB_DIR` identify a child, even if a caller accidentally supplies Topic Agent variables later.
- Do not remove daemon configuration variables that are unrelated to one Topic Agent identity unless a test proves that they can grant Topic affiliation.

## Acceptance criteria

- [ ] A child launched from a complete Topic Main Agent environment cannot produce a valid `TopicAgentEnvironment`.
- [ ] Kitty and the child shell do not receive Topic Agent registration or affiliation credentials.
- [ ] `PI_SUB_JOB_ID`, `PI_SUB_JOB_DIR`, normal shell configuration, model credentials, and unrelated environment values remain available.
- [ ] An ordinary in-window `/new` session still adopts its Topic through the existing affiliation path.
- [ ] Tests cover both launch-time environment sanitization and the reporter defense.
- [ ] No child behavior uses the Main Agent lease as an activity signal.
- [ ] `bun run check` passes.

## Validation

- Targeted launcher environment test.
- `bun test agent/extensions/work/topic-agent/reporter.test.ts`.
- Full harness.

## Comments
