# 02 — Record observable Delegation Job lifecycle

Status: ready-for-agent
Type: feature
Blocked by: 01
Affected extension: `sub`

## Context

The Job Mailbox currently moves from `created` to `launched`, then only changes again when `sub_done` writes `completed`. If a child agent turn settles without a Delegation Result, the mailbox stays `launched`. The parent cannot distinguish active thinking, a child waiting for human input, and a child that incorrectly skipped `sub_done`.

The lifecycle must remain semantic and bounded. It must not copy the child transcript into mailbox status.

## Scope

- Define and validate a typed mailbox status record for:
  - `created`
  - `launched`
  - `thinking`
  - `waiting`
  - `completed`
  - `launch-failed`
- In a child session:
  - write `thinking` on `agent_start`;
  - write `waiting` on `agent_settled` when no Delegation Result exists;
  - do not overwrite `completed` after `sub_done` terminates the turn;
  - move from `waiting` back to `thinking` when the human starts another child turn.
- Keep parent session identity, handoff mode, skill name, and lifecycle timestamps when status changes. Do not erase useful launch metadata with a narrower status object.
- Show a persistent child-side warning when the child settles without `sub_done`. The warning must say that the result was not sent and that the human can continue the child or use `/sub-done`.
- Clear the warning after a new turn starts or the Delegation Job completes.
- Keep status and result writes atomic and in Pi's file mutation queue.

## Acceptance criteria

- [ ] The Job Mailbox distinguishes launched, thinking, waiting, completed, and failed work.
- [ ] A child question or other non-terminal response leaves the Delegation Job in `waiting` without creating a Delegation Result.
- [ ] A model that writes a normal final answer instead of calling `sub_done` produces a visible warning instead of silent apparent completion.
- [ ] `sub_done` writes `completed`, and the later settle event cannot regress it to `waiting`.
- [ ] A later human message changes `waiting` back to `thinking`.
- [ ] Status changes retain the parent and launch metadata needed for reconstruction.
- [ ] Lifecycle tests do not require a real model or Kitty window.
- [ ] `bun run check` passes.

## Validation

- Unit test a child lifecycle harness with `agent_start`, `agent_settled`, and `sub_done` orderings.
- Unit test reload from each durable state.
- Full harness.

## Comments
