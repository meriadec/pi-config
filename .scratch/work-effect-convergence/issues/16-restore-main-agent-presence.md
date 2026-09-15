# Restore Main Agent presence in the Topic list

Status: done

## Parent

`../PRD.md`

## What to build

Restore Main Agent activity as a live, correctly ordered dashboard signal. The runtime animation state must reach rendering, status precedence and labels must match the Topic Agent contract, and activity must reorder complete families without crossing Partition boundaries.

## Acceptance criteria

- [ ] Thinking, Delegated Thinking, Tracking PR, waiting-for-human, idle, stopped, starting, and failed use the previous visible labels and precedence.
- [ ] `thinking-sub` renders as `thinking (sub)` and does not create a child lease.
- [ ] Thinking and Tracking PR use their distinct previous shimmer palettes, and the Effect-owned schedule advances the phase visible to the renderer.
- [ ] The shimmer schedule exists only while at least one rendered activity needs it and stops on settle or disposal.
- [ ] Active complete families sort above inactive peers inside a Partition while children remain below their Parent in Integration Chain order.
- [ ] Stopped list cells stay empty; inactive rows are dim; selected inactive rows retain dim text under the Nord background.
- [ ] Topic details show the same effective activity as the list.
- [ ] Public Topic Agent event, projection, sorting, rendering, schedule, settle, and disposal tests cover the path.
- [ ] The root harness passes.

## Blocked by

- `01-restore-topic-agent-registration.md`
- `11-restore-integration-status-and-ordering.md`
