# Restore pull request presentation and controls

Status: done

## Parent

`../PRD.md`

## What to build

Restore the complete pull request experience from observation facts to the Topic list, details, action rail, direct key, and refresh feedback. The dashboard must show the linked pull request identity and the highest-signal progressive status.

## Acceptance criteria

- [ ] The PR column shows an underlined, clickable `#<number>` and its bounded status when a pull request exists; it is empty otherwise.
- [ ] Status precedence preserves merged, closed, draft, CI failing, feedback, checks, approved, ready, reviewing, and clear.
- [ ] The detail view shows pull request identity, lifecycle, CI, and review state without losing terminal merged or closed identity after restart.
- [ ] Open Pull Request in Browser appears only when a pull request exists.
- [ ] `p` invokes the same browser action only from Topic-list focus and does nothing with an exact unavailable reason when no PR exists.
- [ ] `r` returns local refresh feedback while one single-flight pull request refresh continues and publishes progressive updates.
- [ ] Malformed or failed GitHub observation keeps prior durable identity and publishes a bounded diagnostic.
- [ ] Public observer, status-reduction, rendering, direct-key, browser, refresh, and restart tests cover the complete path.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
