# Delegation Jobs

The `sub` extension starts an interactive Delegation Job in a separate Kitty window. The parent session owns the Job Mailbox and imports the compact Delegation Result. The child transcript and intermediate tool output do not enter the parent context.

## Child boundary

A Delegation Job is not a Topic Main Agent. The child process receives `PI_SUB_JOB_ID` and `PI_SUB_JOB_DIR`, but the launcher removes all `PI_WORK_*` Topic Agent identity values. Thus, the child must not register, adopt, heartbeat, or stop the Topic's Main Agent lease. It must also not import its own Delegation Result. The original parent session ID and session file stay in the Topic manifest.

Do not start another Delegation Job from a child. Recursive delegation is disabled.

## Complete a job

When the delegated work has a terminal outcome, the child must call `sub_done` as its final action. A human can use `/sub-done` instead. These are the only operations that write a terminal Delegation Result. The parent imports that result once and starts one follow-up turn. If the parent Main Agent is already in a turn, Pi queues the follow-up until that turn settles.

If a child turn settles without `sub_done`, the child shows this warning:

> Delegation Result was not sent. Continue this child or use /sub-done.

This is a recoverable waiting state, not a completed job. Continue the child and call `sub_done` after the work completes, or use `/sub-done` to write the result manually. Do not copy the child transcript into the parent.

## Topic dashboard

While a parent-owned Delegation Job has active work, the Topic row and Topic detail show the violet, shimmering label `thinking (sub)`. A normal Main Agent turn has precedence and temporarily shows `thinking`. When that turn settles, `thinking (sub)` returns while delegated work remains active. The Delegation Job does not replace the Topic's Main Agent identity.
