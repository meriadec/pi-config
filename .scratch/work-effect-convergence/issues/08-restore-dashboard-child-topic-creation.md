# Restore child Topic creation in the dashboard

Status: done

## Parent

`../PRD.md`

## What to build

Restore Add Child Topic as a complete Parent Topic action. The child wizard collects a descriptive name, a Start Point on the Parent Topic Branch, and an optional Branch, then starts and follows one Durable Operation.

## Acceptance criteria

- [ ] Add Child Topic appears only for a root Parent Topic and only when creation is available.
- [ ] The wizard shows the Parent Topic and collects name, Start Point, and optional Branch with standard text editing.
- [ ] An empty Branch uses the deterministic Topic-name conversion; an explicit valid Branch is preserved exactly.
- [ ] Start Point resolves to one exact commit and must belong to the Parent Topic Branch in the same local repository.
- [ ] Escape cancels every stage without a request; duplicate submission is blocked.
- [ ] Policy confirmation, progress, cancellation of waiting, timeout, failure, and success use the Durable Operation contract.
- [ ] Success places the child in its Parent family and Partition, preserves pending activation semantics, and selects it.
- [ ] Child Topics never offer Add Child Topic.
- [ ] Public wizard, component, planner, and operation integration tests cover the complete path.
- [ ] The root harness passes.

## Blocked by

- `07-restore-dashboard-root-topic-creation.md`
