# Restore Integration Chain movement and repair

Status: done

## Parent

`../PRD.md`

## What to build

Restore Move in Integration Chain and Reset Integration Target through the dashboard. Movement uses a bounded target chooser and asks for one direct confirmation only when current ancestry does not support the proposed edge. Reset rebuilds a complete family from current ancestry and refuses ambiguity.

## Acceptance criteria

- [ ] Move in Integration Chain appears only for valid child Topics and offers only valid same-family targets plus the Integration Branch where allowed.
- [ ] The chooser supports Vim and arrow movement, Enter submission, and Escape cancellation.
- [ ] An ancestry-supported move applies atomically without confirmation.
- [ ] A move with one unsupported edge shows the exact broken-edge confirmation and applies only after direct approval.
- [ ] Rejection, invalid target, concurrent change, ambiguity, and cross-repository input leave the previous chain unchanged.
- [ ] Reset Integration Target appears only for eligible Parent families, rebuilds the chain atomically, and refuses ambiguous ancestry.
- [ ] Neither action changes Branch or Worktree state.
- [ ] The dashboard immediately renders the new chain order and Integration Status after publication.
- [ ] Public chooser, confirmation, planning, atomicity, refusal, rendering, and reconnect tests cover both actions.
- [ ] The root harness passes.

## Blocked by

- `11-restore-integration-status-and-ordering.md`
- `12-restore-parent-topic-actions.md`
