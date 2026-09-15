# Restore root Topic creation in the dashboard

Status: done

## Parent

`../PRD.md`

## What to build

Restore `a` and `A` as the complete dashboard path for root Topic creation. The wizard collects and reviews the exact Topic identity, provides Known repository completion, starts one Durable Operation, handles direct policy confirmation, and returns to the Topic list with the created Topic selected.

## Acceptance criteria

- [ ] `a` and `A` open the root wizard only when no Create submission is active.
- [ ] The wizard collects name, repository, and editable deterministic Branch in the previous stage order and shows an exact review before submission.
- [ ] Known repositories are fuzzy filtered; arrows move the highlight; Tab completes; Enter submits the typed text rather than the highlight.
- [ ] Empty name, malformed repository, and unsafe Branch values do not advance and show precise validation.
- [ ] Standard cursor editing and bracketed paste work in every field; Escape cancels every stage without submission.
- [ ] Submission uses one stable request identity, handles `allow`, `ask`, and `deny`, and cannot create a duplicate Topic during reconnect or repeated input.
- [ ] Progress and terminal operation state stay bounded and visible without raw Setup output.
- [ ] Success closes the wizard and selects the new Topic; failure keeps useful recovery feedback.
- [ ] Public pure, component, and operation integration tests cover the complete wizard and submission path.
- [ ] The root harness passes.

## Blocked by

- `05-restore-first-run-configuration.md`
- `06-restore-standard-tui-text-entry.md`
