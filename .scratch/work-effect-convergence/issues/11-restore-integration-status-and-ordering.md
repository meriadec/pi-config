# Restore rich Integration Status and family ordering

Status: done

## Parent

`../PRD.md`

## What to build

Restore the complete Integration Status observation from Git calculation through snapshot projection to dashboard presentation. Use the same durable family graph to order children and active families, so status and visual chain order cannot disagree.

## Acceptance criteria

- [ ] Projected Integration Status preserves Current, Behind, Conflict, and Unknown plus exact target, ahead/behind counts, and one bounded diagnostic.
- [ ] The dashboard shows the exact Integration Target, Integration Branch, counts, pending chain state, and diagnostic.
- [ ] Durable children render in Integration Chain order; pending children keep the intended position recorded by their target.
- [ ] Partition remains the primary order, while active Main Agent families sort above inactive peers inside a Partition.
- [ ] The first broken chain edge is yellow or red and later current edges remain green.
- [ ] Rebase availability reports open PR, Worktree cleanliness, checked-out Branch, Git operation, orphan, target operation, active Main Agent, and status reasons before invocation.
- [ ] Observation failure keeps bounded freshness and produces Unknown without discarding a useful diagnostic.
- [ ] Snapshot and RPC schema compatibility is advanced when required, and incompatible daemons restart cleanly.
- [ ] Public Git, projection, stream, ordering, rendering, and rebase-availability tests cover the complete path.
- [ ] The root harness passes.

## Blocked by

None - can start immediately
