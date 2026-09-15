# Restore dashboard navigation, scrolling, and workspace behavior

Status: done

## Parent

`../PRD.md`

## What to build

Converge the remaining dashboard interaction contract after all action and status slices are available. Keyboard behavior must depend on focus, large Topic stores must keep the selected row visible, and workspace access must preserve the previous direct and rail experience.

## Acceptance criteria

- [ ] The three focus positions move list → detail → actions with right or `l`, and actions → detail → list with left or `h`, without closing the sidebar unexpectedly.
- [ ] `q` and `Q` close details; Escape exits the dashboard; Ctrl-C has the documented safe close behavior.
- [ ] Direct shortcuts run only from Topic-list focus, only when their action is available, and never while the same Topic is busy.
- [ ] Action focus supports Vim and arrow movement, preserves the previous boundary behavior, and can explain an unavailable action without invoking it.
- [ ] A bounded Topic window keeps selection visible near the center when possible and accounts for Partition separator rows.
- [ ] Selection stays by Topic ID across sorting and chooses the nearest row after removal.
- [ ] Narrow and wide sidebar thresholds, split ratio, full-height divider, helper row, Note placement, and selected-row styling match the previous layout.
- [ ] `o` and the workspace rail action focus the existing Topic workspace, report pool exhaustion as information, and preserve retry safety.
- [ ] Public reducer, large-list, focus, shortcut, layout, workspace, unavailable-action, and component tests cover the complete interaction matrix.
- [ ] The root harness passes.

## Blocked by

- `03-restore-policy-aware-main-agent-controls.md`
- `04-restore-policy-aware-topic-deletion.md`
- `06-restore-standard-tui-text-entry.md`
- `11-restore-integration-status-and-ordering.md`
- `15-restore-pull-request-presentation.md`
- `16-restore-main-agent-presence.md`
- `17-restore-live-dashboard-feedback.md`
