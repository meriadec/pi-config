# Restore policy-aware Topic deletion

Status: done

## Parent

`../PRD.md`

## What to build

Restore Delete Topic through the shared sensitive Action path while preserving chain-safe metadata deletion. The dashboard must show the exact manifest-only warning, policy must decide whether confirmation is needed, and the nearest remaining Topic must stay selected after success.

## Acceptance criteria

- [ ] `topic.delete` enforces `allow`, `ask`, and `deny` and fails closed on invalid configuration.
- [ ] The direct confirmation states that the Branch and Worktree are not deleted.
- [ ] Denial, rejection, expiry, and failure make no durable Topic or Integration Chain change.
- [ ] Deleting a child repairs its successor target atomically; deleting a Parent Topic with children is refused.
- [ ] Successful deletion selects the nearest remaining Topic instead of jumping to the first Topic.
- [ ] Repeated or retried requests cannot delete another Topic or apply chain repair twice.
- [ ] Public tests cover policy, warning, chain repair, Parent refusal, idempotence, and selection.
- [ ] The root harness passes.

## Blocked by

- `02-restore-policy-aware-terminal.md`
