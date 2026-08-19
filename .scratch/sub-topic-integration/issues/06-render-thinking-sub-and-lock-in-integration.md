# 06 — Render `thinking (sub)` and lock in the Topic integration

Status: ready-for-agent
Type: feature
Blocked by: 03, 04, 05
Affected extensions: `sub`, `work`

## Context

The final user-visible outcome is a Topic list that shows delegated thinking without changing Main Agent identity, plus a reliable Delegation Result handoff to the parent.

The dashboard already has one bounded shimmer timer for `thinking` and `tracking-pr`. Delegated thinking must use that mechanism and must render consistently in both the Topic row and Topic detail.

## Scope

- Map semantic state `thinking-sub` to display label `thinking (sub)`.
- Apply the violet thinking shimmer to the complete label in:
  - narrow Topic rows;
  - wide Topic rows;
  - Topic detail.
- Include `thinking-sub` in `hasShimmeringAgent` so the existing single timer starts and stops correctly.
- Update the shared shimmer period so every animated label loops without a visible jump.
- Keep terminal width guarantees, selected-row highlight behavior, and inactive-row dim behavior.
- Add an integration harness that drives the complete boundary without a real model:
  1. register a Topic Main Agent;
  2. launch a Delegation Job from that parent environment;
  3. prove the child has no Topic Agent identity;
  4. publish child thinking and observe `thinking (sub)` in the dashboard;
  5. run a parent turn and observe `thinking` precedence;
  6. settle the parent and restore `thinking (sub)`;
  7. complete with `sub_done` and import one parent follow-up;
  8. prove the Topic manifest still references the original Main Agent session.
- Add a regression fixture or focused test that catches the historical child self-import sequence.
- Update the `sub` and `work` README material with the child warning and dashboard behavior.

## Acceptance criteria

- [ ] Topic rows show the exact visible text `thinking (sub)` while delegated work is active.
- [ ] The label uses the violet shimmer and moves when the shared phase advances.
- [ ] The shimmer timer runs when only `thinking-sub` is active and stops when all animated activity ends.
- [ ] Main Agent `thinking` has visible precedence and delegated thinking returns afterward.
- [ ] Narrow and wide layouts never exceed terminal width.
- [ ] A completed Delegation Result reaches the parent once.
- [ ] The child never becomes the Main Agent and never imports its own result.
- [ ] The Topic manifest keeps the original Main Agent session ID and session file for the complete scenario.
- [ ] Documentation describes `thinking (sub)` and the recovery action when a child settles without `sub_done`.
- [ ] `bun run check` passes.

## Validation

- Dashboard shimmer and width tests.
- Cross-extension integration test with fake Kitty/process, fake event bus, temporary Job Mailbox, and in-memory or temporary `workd` stores.
- Full harness.

## Comments
