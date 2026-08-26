# 07 — Diagnose slow, cancelled Topic creation

Status: needs-triage
Type: bug
Affected extension: `work`

## Context

A valid `work_topic_create` request waited for a long time and then returned only:

> Topic creation failed: Topic creation was cancelled.

The request used:

- Name: `Correct ppr2 ConfigCat comments`
- Repository: `LedgerHQ/sre-argocd`
- Branch: `correct-ppr2-configcat-comments`
- Start Point: `6264b55312cd654733f25e261fa19df31ec3ba2d`
- Source checkout: the active local checkout

The commit subject was `chore(vault): correct ppr2 ConfigCat comments`. The client had already resolved the repository and commit before it called the tool. No Topic was reported as created, and the client did not retry.

The feature contract currently requires the tool to wait for a terminal provisioning result. This report does not assume that asynchronous provisioning is the correct fix. First identify where the wait occurred and which component requested cancellation.

## Observed behavior

- The call did not return quickly.
- The tool gave no phase, elapsed time, correlation ID, cancellation source, or recovery action.
- The final result did not distinguish client cancellation from daemon, provisioning, process-timeout, or service cancellation.
- The response did not say whether a Topic, Branch, or Worktree was created before cancellation.

## Expected behavior

For valid local repository and commit inputs, Topic creation must do one of these actions:

- create and provision the Topic in a reasonable time, then return its identifiers; or
- fail with a specific reason and an actionable next step.

If the operation waits, progress must identify the current semantic phase. If cancellation occurs, the result must identify the cancellation source and the durable state that remains.

## Investigation scope

- Reproduce the request from a checkout of `LedgerHQ/sre-argocd`.
- Record monotonic timestamps and one correlation ID for:
  1. client request start;
  2. daemon connection and request acceptance;
  3. repository and Start Point resolution;
  4. Topic reservation or manifest creation;
  5. Branch and Worktree provisioning;
  6. Repository Recipe execution, if configured;
  7. cancellation request and source;
  8. final response.
- Determine whether cancellation came from the Pi tool call signal, WorkClient, daemon, process runner, systemd service, timeout, provisioning command, or another actor.
- Check whether user input that arrives while the tool waits cancels the Pi tool call.
- Check daemon and client timeout values and confirm that timeout results cannot be rendered as generic cancellation.
- Inspect the repository, Topic store, Branches, and Worktrees after cancellation for partial state.
- Evaluate whether Topic identity can return before provisioning completes. If synchronous waiting remains required, define bounded phase progress and an explicit timeout.

## Reproduction

From the Source checkout, call `work_topic_create` with the exact values in **Context**. Capture the terminal result and the stage timeline. Repeat with a controlled delayed provisioning step so cancellation and timeout paths are deterministic and fast in tests.

Do not use the original natural-language request as Action-policy confirmation. If the daemon returns confirmation-required, stop and request direct human confirmation separately.

## Acceptance criteria

- [ ] A deterministic, agent-runnable test reproduces the long-wait cancellation path and asserts the reported symptom.
- [ ] The cancellation source is preserved across the process, daemon protocol, WorkClient, and Pi tool boundaries.
- [ ] A cancelled result includes a specific reason, the last completed phase, and an actionable retry or recovery step.
- [ ] Semantic progress shows the current provisioning phase without exposing raw Setup command output or sensitive paths.
- [ ] An explicit timeout is documented and returns a timeout result, not a generic cancellation result.
- [ ] Cancellation does not leave an unreported Topic, Branch, Worktree, or false `ready` state.
- [ ] Any intentional partial state is reconciled on retry or daemon restart and is reported to the caller.
- [ ] Tests cover cancellation before request acceptance, during provisioning, and after durable Topic creation.
- [ ] `bun run check` passes.

## Diagnostic evidence needed

The original report did not include elapsed time, daemon logs, progress events, a correlation ID, or post-cancellation filesystem state. These artifacts are needed before source-level hypotheses can be ranked and tested.

## Comments
