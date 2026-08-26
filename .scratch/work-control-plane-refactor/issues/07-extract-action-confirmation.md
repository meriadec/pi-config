# 07 — Extract Action confirmation

Status: ready-for-agent
Type: refactor
Blocked by: 06
Affected extension: `work`

## Context

Topic Service currently resolves Action policy, creates confirmation tokens, stores operation-specific continuation data, checks client ownership and expiry, and resumes provisioning, deletion, terminal, or Main Agent behavior after approval. The same allow, ask, deny shape is repeated in several Action methods.

## Scope

- Create an internal Action execution module that owns policy resolution and `allow` / `ask` / `deny` behavior.
- Give it one representation for a prepared Action, its bounded human text, its Topic identity, approved Action set, expiry, and continuation.
- Keep confirmation tokens private, client-bound, one-use, and time-bounded.
- Support multi-step provisioning confirmation without adding approval to the original command.
- Keep durable Topic failure transitions and semantic events in the Topic implementation; invoke them through explicit continuation outcomes.
- Replace repeated policy branches in provisioning, terminal, Main Agent, reset, and deletion paths where the behavior is the same.
- Keep Action-specific mutation code local to the owning module. The confirmation module must not become a switch containing every Action implementation.
- Test approval behavior through control-plane commands and direct human adapter workflows.

## Acceptance criteria

- [ ] One internal module owns confirmation token creation, lookup, client binding, expiry, one-use consumption, approval, and rejection.
- [ ] An original command cannot carry approval.
- [ ] A token from one client cannot be used by another client.
- [ ] Expired, reused, and unknown tokens fail with current bounded error semantics.
- [ ] Multi-step provisioning asks once for each required Action and preserves Start Point input.
- [ ] `deny` performs no protected side effect.
- [ ] Direct rejection produces the current Topic outcome and clears live operation state.
- [ ] Topic Service loses the duplicated confirmation and policy scaffolding without gaining per-Action pass-through classes.
- [ ] `bun run check` passes.

## Validation

- Control-plane tests for allow, ask, deny, expiry, wrong client, reuse, and rejection.
- Topic creation tests with multiple confirmations and Start Point preservation.
- Terminal, Main Agent reset, and deletion confirmation tests.
- Full harness.

## Comments
