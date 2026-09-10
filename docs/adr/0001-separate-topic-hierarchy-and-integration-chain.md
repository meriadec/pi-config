# Separate Topic hierarchy from the Integration Chain

Status: accepted

A Topic family uses two durable relationships: a one-level Parent Topic relationship for visual grouping and family Focus, and an Integration Target relationship for Git ordering. Child Topics are checkpoint Branches from commits in the full Parent Topic; Git ancestry inserts them into an Integration Chain from the repository Integration Branch through each child to the full Parent Topic. Keeping these relationships separate preserves the useful parent-and-child display while making broken stacked-Branch edges explicit after rebases.

## Consequences

Integration status uses local committed Branch tips only. It is calculated with Git graph commands and `git merge-tree`, not Worktrunk status or temporary Worktrees. Automatic chain changes require unambiguous ancestry; explicit side-view actions repair exceptional cases. The daemon never fetches, rebases, merges, resets, cherry-picks, or moves an existing Branch as part of integration management.
