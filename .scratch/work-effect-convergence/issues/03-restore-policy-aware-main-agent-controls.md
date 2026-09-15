# Restore policy-aware Main Agent controls

Status: done

## Parent

`../PRD.md`

## What to build

Restore Open Main Agent and Start New Main Agent as complete policy-aware dashboard paths. Opening focuses or resumes the durable Main Agent. Reset starts a new empty Pi session, preserves the previous session file, and rotates private capabilities before launch. Direct and action-rail invocation share availability, policy, confirmation, and result behavior.

## Acceptance criteria

- [ ] `m` opens or focuses the selected Main Agent only from Topic-list focus and only when available.
- [ ] Open Main Agent and Start New Main Agent are available through the action rail with exact unavailable reasons.
- [ ] `agent.open` and `agent.reset` enforce `allow`, `ask`, and `deny` through the shared sensitive Action path.
- [ ] Reset needs direct confirmation only when policy requires it; denial and rejection cause no launch or identity change.
- [ ] A successful reset preserves the prior session file, installs the new durable identity, and rotates capabilities before desktop launch.
- [ ] An existing affiliated window can register or adopt without a false failure message.
- [ ] Public tests cover focus, resume, reset, policy, confirmation, unavailable states, identity rotation, and retry safety.
- [ ] The root harness passes.

## Blocked by

- `01-restore-topic-agent-registration.md`
- `02-restore-policy-aware-terminal.md`
