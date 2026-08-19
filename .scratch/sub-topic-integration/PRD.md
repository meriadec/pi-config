# Epic — Reliable Delegation Jobs in Topics

Status: ready-for-agent
Type: epic
Affected extensions: `sub`, `work`

## Problem

A Delegation Job started with `/sub` from a Topic Main Agent currently inherits the Main Agent's `PI_WORK_*` environment. The child Pi session can use the inherited window affiliation to adopt the Topic's Main Agent lease. This breaks the boundary between the Main Agent and its Delegation Job. A resumed child can then run parent-side mailbox logic and import its own Delegation Result.

The Job Mailbox also has weak lifecycle visibility. A child that settles without calling `sub_done` leaves `status.json` at `launched` forever. This is correct for an intermediate human decision, but it is also the result when a child incorrectly writes a normal final answer instead of producing a Delegation Result. The child and parent have no clear warning or recoverable state.

Finally, the work control plane has no explicit Delegation Job activity. The Topic list cannot show that the Main Agent has delegated work in progress.

## Outcome

- A Delegation Job cannot register, adopt, heartbeat, or stop a Topic's Main Agent lease.
- The Job Mailbox records observable child lifecycle states.
- A child that settles without `sub_done` clearly requests a terminal Delegation Result or more human input; it does not silently appear complete.
- A completed Delegation Result reaches the exact parent session once, including after reload and while a Main Agent turn is active.
- The Topic list and Topic detail show `thinking (sub)` with the violet shimmer while a child agent turn is active.
- A normal Main Agent turn has display precedence over Delegation Job activity. When that turn settles, live Delegation Job activity becomes visible again.

## Non-goals

- Do not merge child transcripts or raw tool output into the parent context.
- Do not automatically classify every final assistant message as a Delegation Result. It can be a request for credentials, confirmation, or another human decision.
- Do not route parent replies into the child session.
- Do not let the child impersonate the Main Agent to obtain dashboard activity.
- Do not add recursive Delegation Jobs.

## Required design boundaries

### Process identity

`PI_SUB_JOB_ID` and `PI_SUB_JOB_DIR` identify a child Delegation Job. Topic Agent credentials are not part of its Context Packet and must not cross the child process boundary.

### Durable lifecycle

The Job Mailbox is the source of truth for Delegation Job lifecycle. Writes stay atomic and use Pi's file mutation queue. Parent activity reconstruction must work after `/reload` and session resume.

### Control-plane telemetry

The parent `sub` extension publishes semantic Delegation Job activity through Pi's extension event bus. The Topic Agent reporter owns precedence and sends a distinct control-plane state to `workd`. The child does not connect to `workd`.

### Handoff

`sub_done` and `/sub-done` remain the only operations that create a terminal Delegation Result. Settling without one creates an observable non-terminal state and a child-side warning.

## State and precedence

Suggested Job Mailbox states:

1. `created`
2. `launched`
3. `thinking`
4. `waiting`
5. `completed`
6. `launch-failed`

`created`, `launched`, and `thinking` count as active Delegation Job work. `waiting` means the child has settled without a Delegation Result. A later human message can move it back to `thinking`.

Suggested Topic Agent display precedence:

1. `thinking` — the Main Agent has an active turn
2. `thinking-sub` — at least one Delegation Job has active work
3. `tracking-pr` — Tracking PR is active
4. `waiting-for-human` / idle state

The dashboard label for `thinking-sub` is `thinking (sub)`.

## Delivery guarantees

- A completed Job Mailbox result is imported only by its recorded parent session.
- Import is idempotent by Delegation Job ID.
- Reload or temporary read failure cannot lose a completed result.
- A result completed during a Main Agent turn is queued as a follow-up and starts the handoff turn after the Main Agent settles.
- A child session never starts parent-side result watchers.

## Validation

- Unit tests at the process-environment, mailbox coordinator, reporter, protocol, daemon, and dashboard seams.
- An integration test drives: Topic Main Agent → `/sub` launch → child thinking → child `sub_done` → parent follow-up.
- The integration test proves that the Topic manifest keeps the Main Agent session ID and session file throughout the Delegation Job.
- `bun run check` passes.

## Issue order

1. `01-isolate-child-from-topic-agent.md`
2. `02-record-delegation-job-lifecycle.md`
3. `03-make-parent-result-import-reliable.md`
4. `04-bridge-delegation-activity-to-topic-reporter.md`
5. `05-add-thinking-sub-control-plane-state.md`
6. `06-render-thinking-sub-and-lock-in-integration.md`

Issues 02 and 03 can start after issue 01. Issue 05 can run in parallel with issues 02–04. Issue 06 is the final integration issue.

## Comments
