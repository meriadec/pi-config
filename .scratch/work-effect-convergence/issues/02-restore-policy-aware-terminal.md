# Restore policy-aware terminal actions

Status: done

## Parent

`../PRD.md`

## What to build

Use Open Terminal as the complete tracer for sensitive dashboard Actions. The configured Action policy must reach the dashboard and daemon decision, direct and rail invocation must share one path, and retries must not repeat an accepted side effect. This slice establishes the reusable authorization and confirmation seam for later Main Agent and delete slices.

## Acceptance criteria

- [ ] `t` opens a new terminal for the selected ready Topic only while the Topic list has focus.
- [ ] Open Terminal remains available from the action rail with the previous availability explanation.
- [ ] `allow` executes, `deny` performs no terminal side effect, and `ask` needs an exact direct human confirmation.
- [ ] Rejection, denial, confirmation expiry, failure, and success stay distinct and visible to the user.
- [ ] Invalid or unavailable configuration fails closed.
- [ ] A transport retry keeps one stable command identity and cannot open a duplicate terminal.
- [ ] The policy result is projected so the dashboard can mark a denied action unavailable without attempting it.
- [ ] Public tests cover direct key, action rail, all policy decisions, confirmation, retry, and cleanup.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
