# Adopt a new in-window Main Agent session

Status: needs-triage

## Context

Read the PRD and issue 06 (resumable Main Agent and telemetry). A Main Agent is one
visible interactive Pi session per Topic. Its affiliation is pinned to one
daemon-assigned session identity `topic.mainAgent.sessionId`, enforced in three
layers:

1. Reporter guard (`topic-agent/reporter.ts`): registers only when the live Pi
   session id equals `PI_WORK_SESSION_ID`.
2. Launch token (`daemon/main-agent.ts`): a non-secret per-launch registration
   token bound to `{topicId, sessionId}` with a 30 s TTL.
3. Daemon `register()`: rejects unless the incoming session equals both the
   token session and `topic.mainAgent.sessionId`.

When the user runs `/new` inside the Main Agent window, Pi starts a fresh
session id. All three layers then reject it: the reporter guard skips, the launch
token is expired and bound to the old session, and the daemon identity check
fails. The window keeps running but stops sending heartbeats, so its Main Agent
lease becomes `failed` after the heartbeat deadline. The window silently detaches
from its Topic.

The supported fresh-session path today is the dashboard action
**Start New Main Agent** (`agent.reset`), which closes the window, assigns a new
session id, mints a new token, and relaunches. This issue adds an in-window path
so `/new` keeps affiliation instead of detaching.

## Objective

Let an affiliated Main Agent window adopt its own new Pi session as the Topic's
Main Agent, keeping affiliation, without weakening cross-Topic or cross-window
identity guarantees.

## Scope

Durable window affiliation:

- Give the Main Agent window a durable, non-secret affiliation credential scoped
  to the window process lifetime, passed through the existing explicit
  environment variables. This replaces or supplements the one-shot 30 s launch
  token for adoption. The affiliation must identify the Topic and the window, not
  a single session id.
- Keep the credential out of manifests and logs. It is not a secret but must not
  leak into command transcripts.

Reporter (`topic-agent/reporter.ts`):

- When the explicit Topic environment is present and the live Pi session id
  differs from `PI_WORK_SESSION_ID`, do not skip. Register the actual live
  session id as an adoption using the durable affiliation credential.
- Keep the existing exact-match path for the originally launched session.
- Report the adopted session's lifecycle exactly as a normal Main Agent session:
  initial connected session is `idle`, `agent_start` is `thinking`, a settled
  turn awaiting the human is `waiting-for-human`, shutdown is `stopped`.
- Keep heartbeats and cleanup session-scoped. A `/new` within one window process
  must not leak timers, sockets, or connections from the previous session.

Daemon (`daemon/main-agent.ts`, `daemon/protocol.ts`):

- Add an adoption path to `register()`: when the affiliation credential proves
  the caller is this Topic's Main Agent window, accept a session id that differs
  from `topic.mainAgent.sessionId`, update `topic.mainAgent.sessionId` to the new
  session, persist the reported session file, and refresh the lease.
- Preserve "at most one live Main Agent per Topic": adoption replaces the
  previous session for the same window; it does not create a second lease.
- Continue to reject a genuinely foreign session (wrong Topic, wrong window, or
  no valid affiliation) with a bounded error.
- Do not inspect or copy Pi session contents. Keep the previous session file on
  disk; only repoint durable identity.
- Emit Main Agent state events and include state in snapshots as today.

## Tests

Add tests with fake Pi events, time, desktop adapters, and sockets for:

- Adoption: an affiliated window registers a new session id; the Topic's durable
  session identity updates and the lease becomes live for the new session.
- The originally launched session still registers via the exact-match path.
- A foreign session without valid affiliation is rejected.
- Cross-Topic and cross-window adoption attempts are rejected.
- Adoption still enforces at most one live Main Agent per Topic.
- Reporter cleans up the previous session's timers and connection before
  registering the adopted session.
- Session file persistence without session-content access.

Run `bun run check`.

## Acceptance criteria

- Running `/new` inside a Main Agent window keeps the window affiliated with its
  Topic; the dashboard shows the adopted session as the live Main Agent.
- Start New Main Agent continues to work unchanged.
- At most one live Main Agent exists per Topic at any time.
- Foreign, cross-Topic, and cross-window sessions cannot claim a Topic.
- No credentials or Pi session contents enter manifests or logs.
- All extension-started timers, sockets, and connections stay session-scoped and
  are cleaned up.
- The repository harness passes.

## Open questions and decisions

- Durable credential shape: extend the launch token lifetime for the window
  lifetime, or issue a separate long-lived window affiliation token in addition
  to the short-lived launch token. Decide before implementation.
- Whether adoption should be silent or surface a brief dashboard note that the
  Topic's session identity changed.
- Whether the previous, now-detached session file should be recorded anywhere for
  recovery, or simply left on disk.

## Dependencies

- Issue 06
