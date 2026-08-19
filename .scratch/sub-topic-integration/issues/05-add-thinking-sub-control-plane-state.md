# 05 — Add `thinking-sub` to the work control plane

Status: done
Type: feature
Blocked by: none
Affected extension: `work`

## Context

The work control plane currently has no state for delegated thinking. Reusing `thinking` would lose the distinction requested in the Topic list. Reusing Main Agent adoption would violate the Main Agent lease boundary.

A distinct semantic state must travel from `TopicAgentReporter`, through the client protocol and `workd`, into dashboard snapshots and events.

## Scope

- Add `thinking-sub` to `MainAgentState` and all runtime validation sets.
- Add the corresponding reporter/client request and daemon transition support. Keep protocol parsing bounded and explicit.
- Decide the wire action name in the same style as `agent.thinking` and `agent.tracking-pr`; do not encode display text in the protocol.
- Keep one lease per Topic. The state belongs to the parent Main Agent lease and does not introduce a child lease.
- Treat `thinking-sub` as an active Main Agent state for Topic sorting and heartbeat expiry.
- Preserve compatibility with snapshots and manifests that predate the state. No manifest version change is needed unless persisted data actually gains a new field.
- Update work control-plane documentation to define delegated thinking and its precedence.

## Acceptance criteria

- [ ] The protocol accepts the exact new action/state and rejects unknown variants.
- [ ] A registered Main Agent can transition through `thinking-sub`, other active states, and stopped states.
- [ ] Heartbeats and expiry behave like other connected active states.
- [ ] Topic sorting treats `thinking-sub` as active.
- [ ] No child session ID or child session file replaces the Topic's Main Agent reference.
- [ ] Existing clients and snapshots without `thinking-sub` continue to work.
- [ ] Domain and daemon tests cover the new state.
- [ ] `CONTEXT.md` and `agent/extensions/work/README.md` use the project terms and document precedence.
- [ ] `bun run check` passes.

## Validation

- Shared domain parsing tests.
- Protocol request tests.
- `MainAgentManager` transition and heartbeat tests.
- Full harness.

## Comments
