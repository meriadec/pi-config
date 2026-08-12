# Launch one resumable main agent and report its state

Status: done

## Context

Read the PRD and issues 01-05. A Main Agent is one visible interactive Pi session per topic. It is not a Delegation Job and must not use the Delegation Job mailbox protocol.

## Objective

Launch or focus the topic's main agent and report its semantic Pi lifecycle state to `workd`.

## Scope

Main-agent launch:

- Add daemon action `agent.open` with policy enforcement.
- Require a ready topic and a topic workspace from the i3 adapter.
- If a marked live main-agent window exists, focus it and do not spawn another.
- Otherwise launch kitty with `--single-instance --instance-group i3` in the topic worktree.
- Start Pi with a deterministic session ID based on the topic ID and a useful session name. Repeated launch must resume that session.
- Pass explicit environment variables for topic ID, socket path, and a non-secret per-launch registration token.
- Give main-agent windows a distinct identity from normal topic terminals while retaining the topic i3 mark.
- Persist the reported Pi session file when the child connects. Do not inspect or copy session contents.

Topic-agent telemetry:

- In the global `work` extension, detect the explicit topic environment. In normal sessions, do not connect as a topic agent.
- Register with `workd` and validate the short-lived token.
- Report `session_start`, `agent_start`, `agent_settled`, and `session_shutdown` transitions.
- Send a bounded heartbeat while the child session lives and clean it up in `session_shutdown`.
- Initial blank connected session is `idle`.
- `agent_start` is `thinking`.
- A settled assistant turn awaiting another user action is `waiting-for-human`.
- Normal shutdown/disconnect is `stopped`; launch failure or unexpected heartbeat loss is `failed` with a bounded reason.
- Reconnection replaces stale connection state only when topic/session identity matches.

Daemon behavior:

- Track one main-agent lease per topic.
- Reject a second different live session for the same topic.
- Emit main-agent state events and include state in snapshots.
- Keep durable session identity separate from live connection state.

## Tests

Add tests with fake Pi events, time, desktop adapters, and sockets for:

- First launch command and deterministic session identity.
- Focus instead of duplicate launch.
- Valid and invalid registration token.
- Idle, thinking, waiting-for-human, stopped, and failed transitions.
- Heartbeat expiry and reconnect.
- Session file persistence without session-content access.
- Cleanup of heartbeat timers and connections.
- No topic-agent behavior in an ordinary Pi session.

Run `bun run check`.

## Acceptance criteria

- Repeated Open Main Agent results in at most one live main agent for the topic.
- The same Pi session is resumed after a normal close/relaunch.
- Dashboard clients can observe live state without parsing terminal output.
- All extension-started timers and connections are session-scoped and cleaned up.
- The repository harness passes.

## Dependencies

- Issue 05

## Comments
