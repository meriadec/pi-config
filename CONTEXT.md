# Pi Configuration

This context captures local Pi agent configuration concepts that are specific to this repository.

## Language

**Grillade**:
A focused Pi extension experience for running a structured grilling interview in a dedicated UI while preserving the interview state in a normal Pi session.
_Avoid_: grill-me UI, grilling wrapper, interview modal

**Grillade Question**:
A structured interview turn with a pinned question, selectable option cards, one recommended default answer, confidence indicators, and a custom-answer path.
_Avoid_: prompt, chat message, question text

**Semantic Grillade State**:
The durable interview state persisted to the Pi session, including active unanswered question, submitted answers, pending documentation proposals, and final actions.
_Avoid_: UI state, draft state, scroll state

**Delegation Job**:
A durable unit of delegated agent work created by the parent Pi session, executed in an isolated child Pi process, and tracked until it produces a compact result for the parent session.
_Avoid_: terminal, subprocess, task

**Delegation Result**:
The compact, parent-visible outcome of a Delegation Job, intended to summarize conclusions and relevant handoff data without exposing the child process's full command outputs or intermediate context.
_Avoid_: logs, transcript, stdout

**Job Mailbox**:
The durable filesystem handoff location owned by a Delegation Job, containing the parent-written request and child-written status/result artifacts used to communicate across separate Pi processes.
_Avoid_: socket, terminal output, session transcript

**Context Packet**:
The explicit, bounded startup information passed from the parent session to a Delegation Job, excluding the full parent conversation unless the user opts into a summary handoff.
_Avoid_: conversation dump, prompt, system prompt

**Branch**:
A Topic's exact Git branch name. A Branch identifies a Topic within its GitHub repository.
_Avoid_: slug, branch slug

**Start Point**:
The exact Git commit from which a new Topic Branch starts. It is creation input and does not become part of the Topic's durable identity.
_Avoid_: base branch, source branch, starting branch

**Source checkout**:
The Git checkout in which a client resolves a Start Point before it requests Topic creation. It is creation input and can differ from the repository's Base checkout.
_Avoid_: current repo, source repository, invoking repo

**Integration Branch**:
The local Branch of a repository that a root Topic integrates into. It is inferred once from local Git refs and then persisted in that repository's configuration entry.
_Avoid_: main branch, trunk, default branch

**Integration Target**:
The durable link from a Topic to the Branch that this Topic must contain. It is either the repository Integration Branch or another Topic of the same family.
_Avoid_: parent branch, upstream, base

**Integration Chain**:
The single ordered path from the Integration Branch through the children of one family to the Parent Topic.
_Avoid_: stack, dependency tree, hierarchy

**Parent Topic**:
The root Topic of a one-level family. It owns visual hierarchy and family Focus; a child Topic can never have children.
_Avoid_: parent branch, epic, group

**Origin Commit**:
The immutable commit of a Parent Topic Branch at which a child Topic Branch started. It is provenance and duplicate protection only; it never defines chain order or Integration Status.
_Avoid_: base commit, fork point, start point

**Chain Plan**:
The complete set of durable Topic edits that one Integration Chain mutation needs. The engine returns a Chain Plan or a bounded rejection; a caller applies an accepted Chain Plan atomically.
_Avoid_: patch, diff, transaction

**Chain activation**:
The single moment at which a Pending child enters the active Integration Chain. It happens only after setup finished, revalidates current Branch tips, and writes the child's own activation last, so a refusal keeps the previous healthy chain.
_Avoid_: publish, promote, commit the chain

**Branch ancestry**:
The committed containment relation between two local Branch tips, read with one bounded `git merge-base --is-ancestor` question. An answer that Git cannot give is ambiguous, and ambiguity always refuses automatic placement.
_Avoid_: merge base, history check

**Pending child**:
A child Topic that has an intended chain position but is not yet part of the active Integration Chain, because provisioning is not finished or its position became ambiguous.
_Avoid_: draft topic, inactive topic

**Integration Status**:
Where one Topic Branch stands against its Integration Target, observed from committed local Branch tips only: Current, Behind, Conflict, or Unknown. It never uses remote refs, Worktree changes, or Worktrunk status.
_Avoid_: sync state, rebase state, branch health

**Chain maintenance**:
One safe repair of a family or of its Integration Chain: Change Parent, Remove Parent, Move in Integration Chain, or Reset Integration Target. It only rewires durable links, and it never runs fetch, pull, rebase, merge, reset, cherry-pick, or a Branch movement.
_Avoid_: restack, rebase action, chain surgery

**Legacy name hierarchy**:
A Topic family that only `>` names express, without durable Parent Topic data. It is the migration source, and the list renders it only while it stays unresolved.
_Avoid_: name path, implicit family

**Legacy migration**:
The previewed, approved, metadata-only move of legacy name hierarchies to durable Parent and Integration Target data. It writes manifest backups and a recovery journal first, and it never runs a Git history or Worktree mutation.
_Avoid_: name import, auto-migration

**Migration journal**:
The private durable record of one legacy migration run: the planned families, the completed families, and the pre-migration manifest backups that recovery restores.
_Avoid_: migration log, undo file
