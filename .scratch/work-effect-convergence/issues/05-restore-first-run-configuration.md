# Restore first-run Work configuration

Status: done

## Parent

`../PRD.md`

## What to build

Restore the first-run `/work` configuration flow for a missing Work Base while keeping strict versioned configuration. The human can select one writable absolute Work Base, cancel safely, or correct invalid input before the dashboard connects.

## Acceptance criteria

- [ ] A missing Work Base causes `/work` to request it before daemon connection or dashboard construction.
- [ ] Home-relative input is expanded and the result must be an absolute, existing, writable directory.
- [ ] Invalid, missing, non-directory, and non-writable paths produce precise feedback and do not install partial configuration.
- [ ] Cancellation writes nothing and does not start or connect to the daemon.
- [ ] Saving Work Base preserves all existing policy and repository configuration.
- [ ] The resulting strict configuration has private atomic write behavior and passes normal startup validation.
- [ ] Public command tests cover TUI guarding, first-run setup, validation, cancellation, preservation, and one-time registration.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
