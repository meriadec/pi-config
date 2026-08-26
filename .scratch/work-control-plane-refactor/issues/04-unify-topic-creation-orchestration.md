# 04 — Unify Topic creation orchestration

Status: ready-for-agent
Type: refactor
Blocked by: 03
Affected extension: `work`

## Context

The CLI and `work_topic_create` tool separately resolve Topic input, connect to the daemon, create with a stable request ID, process confirmation rounds, cancel work, close the client, and convert terminal outcomes. Only Git input resolution is currently shared.

## Scope

- Add one Topic creation application module with a small interface for one complete creation attempt.
- The module owns input resolution, daemon connection lifetime, stable request identity, command execution, repeated confirmation handling, cancellation, progress translation, and cleanup.
- Accept adapters for direct human confirmation and semantic progress. Make absence of a confirmation adapter return `confirmation-required` without approval.
- Return one presentation-neutral `TopicCreationOutcome` union.
- Keep CLI flag parsing, terminal prompts, JSON, diagnostics, and exit codes in the CLI adapter.
- Keep TypeBox parameters, Pi dialogs, tool updates, and tool result rendering in the Pi adapter.
- Keep dashboard creation on its existing explicit Topic command unless using the full application module simplifies a real dashboard requirement.
- Delete duplicate creation-client interfaces and duplicate cancellation or confirmation loops.
- Test the workflow through the new application interface; retain adapter tests for presentation-specific behavior.

## Acceptance criteria

- [ ] CLI and Pi tool invoke the same Topic creation application interface.
- [ ] Repository, Branch, Start Point, and Source checkout resolution occurs once per attempt.
- [ ] Each confirmation round uses a new request ID derived from one stable creation identity.
- [ ] Headless use returns `confirmation-required` and never approves.
- [ ] Direct rejection sends `action.reject` and returns the rejection outcome.
- [ ] Cancellation closes the connection and cannot emit a later success.
- [ ] CLI output and Pi tool output remain byte- or structure-compatible where documented.
- [ ] Duplicate workflow tests are replaced by application behavior tests plus thin adapter tests.
- [ ] `bun run check` passes.

## Validation

- Application tests for success, multiple confirmations, rejection, policy denial, timeout, cancellation, conflict, and disconnect.
- CLI JSON and exit-code tests.
- Pi direct-dialog and bounded-progress tests.
- Real daemon integration test for both adapters.

## Comments
