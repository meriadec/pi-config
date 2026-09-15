# Connect Integration Branch source and reset

Status: done

## Parent

`../PRD.md`

## What to build

Show whether each repository Integration Branch is configured or inferred and expose Reset Integration Branch for eligible inferred state. Reset clears only stored inference so the next safe observation can infer again; it never moves a Branch.

## Acceptance criteria

- [ ] Topic details show the exact Integration Branch and whether its source is configured or inferred.
- [ ] Unknown and invalid configuration states have bounded, fail-closed diagnostics.
- [ ] Reset Integration Branch appears only for inferred repository state and is unavailable for an explicit configured override.
- [ ] Direct confirmation identifies the repository and states that no Branch or Git history moves.
- [ ] Success atomically clears only inferred repository state and triggers safe status refresh.
- [ ] Rejection, retry, and concurrent revision failure do not clear newer state.
- [ ] The action remains available and correct after dashboard or daemon reconnect.
- [ ] Public projection, action, confirmation, command, rendering, and reconnect tests cover configured and inferred state.
- [ ] The root harness passes.

## Blocked by

- `11-restore-integration-status-and-ordering.md`
