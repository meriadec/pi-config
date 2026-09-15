# Restore the Topic creation CLI contract

Status: done

## Parent

`../PRD.md`

## What to build

Restore the complete `pi-work topic create` and `topic create-child` command contract on the Effect path. Parsing must be strict before connection, interactive and headless policy behavior must remain distinct, and process interruption must stop only the client wait.

## Acceptance criteria

- [ ] Root and child commands accept the documented exact flags, current-directory defaults, explicit Source checkout, repository, Branch, Parent Topic, and Start Point behavior.
- [ ] Unknown, duplicate, missing, malformed, and incompatible options fail with usage status before daemon connection.
- [ ] Interactive `ask` accepts explicit yes or no on the same client; no rejects rather than approves.
- [ ] JSON and non-interactive use return confirmation-required with the documented distinct exit status and never self-approve.
- [ ] Ctrl-C and disconnect stop waiting without reporting success or cancelling accepted daemon work.
- [ ] The CLI retains its previous long wait deadline instead of inheriting the shorter Pi tool default.
- [ ] Every client is disposed after success, parse/config/planning failure, rejection, timeout, cancellation, or disconnect.
- [ ] JSON emits one versioned object on stdout; bounded diagnostics stay on stderr; conflict and resolver details remain useful.
- [ ] Root, child, policy, syntax, output, timeout, cancellation, cleanup, and real daemon tests cover the commands.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
