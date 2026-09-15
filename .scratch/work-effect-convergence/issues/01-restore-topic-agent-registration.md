# Restore Topic Agent registration and re-attachment

Status: done

## Parent

`../PRD.md`

## What to build

Restore the complete Topic Agent registration contract on the Effect path. An original Main Agent session registers, an affiliated in-window session adopts, and a Topic Agent whose daemon lease disappeared re-attaches in the same recovery cycle. A failed heartbeat is not itself a failed re-attachment and must not produce the current false error. Effective activity is reasserted after a new lease.

## Acceptance criteria

- [ ] A missing live connection after daemon restart causes an immediate register-or-adopt attempt in the same cycle.
- [ ] The reporter logs `re-attach failed` only when the register-or-adopt attempt fails, not when the preceding heartbeat reports an absent connection.
- [ ] Registration, adoption, session-name restoration, affiliation refusal, and Delegation Job isolation preserve the previous behavior.
- [ ] Thinking, Delegation Job, Tracking PR, waiting-for-human, and stopped precedence is preserved and reasserted after recovery.
- [ ] Shutdown reports stopped when appropriate and releases the owned schedule and runtime.
- [ ] Public reporter tests cover the previous registration, adoption, restart, activity, and cleanup matrix.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
