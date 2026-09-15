# Restore standard TUI text entry

Status: done

## Parent

`../PRD.md`

## What to build

Restore one reusable standard TUI text-entry seam and use it end to end for Rename Topic and Topic Note. The editor must support normal cursor movement and paste behavior instead of append-only string reduction.

## Acceptance criteria

- [ ] Rename and Note editors support cursor movement, insertion, deletion, bracketed paste, and standard focused input behavior.
- [ ] Note input normalizes pasted line breaks to spaces and stays one line.
- [ ] Rename rejects empty input; Rename and Note enforce their exact 200-character limits without closing on error.
- [ ] Saving an empty Note removes it, and Escape cancels without a mutation.
- [ ] A successful Rename changes only the Topic name; it does not change Branch, repository, Worktree, hierarchy, or Partition.
- [ ] Text input focus follows dashboard focus and is released on editor close and component disposal.
- [ ] Public reducer and component tests cover editing, paste, validation, save, cancel, and cleanup.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
