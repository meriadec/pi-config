# Restore and prove both Pi Topic creation tools

Status: done

## Parent

`../PRD.md`

## What to build

Restore the complete public contract of `work_topic_create` and `work_topic_create_child` on the Effect Durable Operation path. Both tools must resolve the same semantic input as the dashboard and CLI, wait without owning operation lifetime, and return bounded, useful results.

## Acceptance criteria

- [ ] Both stable tool names register once with focused schemas, labels, descriptions, and model guidance.
- [ ] Root creation defaults Source checkout to the session directory, infers repository when needed, resolves an exact Start Point, and preserves explicit repository and Branch.
- [ ] Child creation defaults Parent Topic from the Main Agent environment, accepts an explicit Parent outside it, and validates exact Parent Branch ancestry.
- [ ] Blank optional arguments are omitted and oversized tool-call IDs never become request IDs.
- [ ] `ask` uses the exact direct daemon action text; headless use returns confirmation-required and never self-approves; rejection and denial stay distinct.
- [ ] Cancellation and timeout stop only waiting, return the last useful operation identity, and leave accepted daemon work running.
- [ ] Progress and errors are bounded semantic data with no raw Setup output or private capability.
- [ ] Equivalent tool, CLI, and dashboard inputs produce equivalent planned Durable Operation subjects.
- [ ] Public registration, execution, policy, cancellation, timeout, error-matrix, and real integration tests cover both tools.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
