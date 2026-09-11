# Allow guarded explicit Topic rebases

Status: accepted

The daemon can rebase one selected Topic Branch onto its direct local Integration Target through an explicit dashboard action. This is separate from metadata-only Integration Chain maintenance and replaces ADR-0001's absolute prohibition on daemon-owned rebases because the common, conflict-free repair should not require a manual terminal workflow.

## Consequences

The action runs only for a Behind Topic with a clean Worktree, the correct Branch checked out, no Git operation in progress, no known open pull request, and no Main Agent that is starting or thinking. It uses no network, asks for no confirmation, and runs a plain non-interactive `git rebase` for one edge. A failed rebase is never continued or aborted automatically; its Git Operation State remains visible for manual handling.
