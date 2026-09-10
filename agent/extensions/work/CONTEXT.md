# Work control plane

`work` is a local control plane for durable Topics: named units of work, each on a Branch of a
GitHub repository, with a provisioned worktree and a resumable Main Agent.

## Language

**Topic**:
A durable unit of work bound to one `owner/repo` repository and one Branch, with its own worktree
and Main Agent. Stored as a manifest under `~/work/topics/<topic-id>/topic.json`.

**Topic Note**:
A durable, optional free-text annotation on one Topic. It gives human context without changing the
Topic's name, identity, hierarchy, Focus, or sort order.
_Avoid_: comment, status message.

**Base checkout**:
The single clone of a repository, shared by all Topics of that repository. By default it lives
at `WORK_BASE/<repo-name>`. A **Base checkout override** (`basePath` in a repository entry of
`~/work/config.json`) puts it at a fixed absolute path outside `WORK_BASE` instead, so a Topic can
adopt an existing checkout (for example `~/.pi`).

**Start Point**:
The exact Git commit from which a new Topic Branch starts. An existing Branch is accepted only when
its tip is this commit. For a child Topic, it is retained as the Origin Commit.
_Avoid_: base branch, source branch, starting branch.

**Origin Commit**:
The immutable Start Point recorded for a child Topic. It supplies creation provenance and prevents
duplicate child Start Points; it does not select Integration Targets or determine Integration Status.

**Parent Topic**:
The optional full-feature Topic that contains a child checkpoint Topic. Parent and child belong to
the same repository. A child cannot itself be a Parent Topic. The relationship controls visual
hierarchy and family Focus. It does not directly select the child's Integration Target. A Parent
Topic cannot be deleted while it has children.

**Integration Branch**:
The local repository Branch into which a Topic family is expected to integrate. It is the first
Integration Target in that family's Integration Chain.
_Avoid_: default branch, base branch, main branch.

**Integration Target**:
The local Branch against which a Topic's Integration Status is measured. It is either the repository
Integration Branch or another Topic's Branch.
_Avoid_: reference worktree, comparison branch.

**Integration Chain**:
The ordered Branch chain from a repository's Integration Branch through child checkpoint Topics to
their full Parent Topic. A new child is inserted by Git ancestry. The nearest earlier child is its
Integration Target, and the immediate later child targets it. The full Parent Topic targets the last
child. With no children, the Parent Topic targets the Integration Branch. Durable Integration Target
links keep this order when commit SHAs change. Every Current link means that the full Parent Topic's
history contains all child Topic tips. Two children of one Parent Topic cannot start at the same
commit.

**Integration Status**:
The local committed relationship between a Topic Branch and its Integration Target. **Current**
means the target tip is an ancestor of the Topic tip. **Behind** means the target has commits absent
from the Topic. **Conflict** means the Topic is Behind and merging it into the target is predicted to
conflict. **Unknown** means that a reliable result is not available. Uncommitted Worktree changes
and remote state do not affect this status.
_Avoid_: worktree state, Git status.

**Source checkout**:
The Git worktree in which a client resolves a Start Point. It can have a different path from the
Base checkout, but it must share the Base checkout's local clone and Git object database. It is
creation input and is not part of the Topic.
_Avoid_: current repo, source repository, invoking repo.

**Worktree**:
The per-Topic Git worktree, created from the Base checkout for the Topic Branch. The Topic's own
working directory.

**Repository Recipe**:
The ordered `setupCommands` declared for a repository in `~/work/config.json`, keyed by
`owner/repo`. Run once, line by line, to prepare a freshly created Worktree (for example
`pnpm install`, then a build, then copying an env sample). Not run when a Worktree already exists.
Running the Recipe is an observable provisioning phase, shown live in the control-plane list view.
_Avoid_: bootstrap script, provisioning script, init hook.

**Setup command**:
One line of a Repository Recipe. A full shell line (with arguments) run in the Worktree.

**Action policy**:
The `allow` / `ask` / `deny` decision that gates a sensitive Action (clone, worktree creation,
etc.), resolved from defaults plus per-repository and per-Topic overrides.

**Topic hierarchy**:
The durable one-level family formed by Parent Topic relationships. The list shows checkpoint Topics
below their full Parent Topic with tree connectors. A family's active Main Agents move the family
together, but a child never moves above its parent. Topic names do not define or change this
hierarchy.
_Avoid_: Topic name hierarchy, name path.

**Focus**:
The durable follow-state of a Topic hierarchy subtree: **Focused** (the upper part) or **Unfocused**
(the lower part, below a blank separator). The two on-screen lists are only a rendering of this
state. Focus is the dominant sort key. Topic hierarchy families stay together. A family with an
active Main Agent comes before an inactive family; active descendant subtrees come before inactive
sibling subtrees, and names break ties. Shift+K focuses the selected Topic and all descendants;
Shift+J unfocuses them. Selection follows the selected Topic. A Topic with no recorded state is
Focused, so new Topics and Topics from older manifests start Focused.
_Avoid_: hot list, pinned, archived, two lists.

**Known repository**:
An `owner/repo` repository already declared in `~/work/config.json` (a key of the Repository
Recipe map). The set of Known repositories is offered as fuzzy-matched completions when you name a
Topic's repository in the add-topic wizard.
_Avoid_: saved repo, configured repo.

**Delegated Thinking**:
The live Main Agent activity while one or more parent-owned Delegation Jobs run for its Topic.
Shown as `thinking-sub`. It stays on the parent Main Agent lease: a Delegation Job does not replace
the Topic's Main Agent session ID or create a child lease. Thinking has display precedence over
Delegated Thinking; Delegated Thinking has precedence over Tracking PR.
_Avoid_: child agent lease, Main Agent adoption, delegated session

**Tracking PR**:
The live Main Agent activity while `/track-pr` polls one pull request in the background. The display
precedence is Thinking, then Delegated Thinking, then Tracking PR, then waiting for a human. When a
higher-precedence activity settles, the next live activity becomes visible until it completes,
fails, or is cancelled.
_Avoid_: waiting for human, reviewing PR.

**Orphan Topic**:
A Topic that claims a ready Worktree whose recorded path is no longer a directory. The durable Topic
record still exists, but its Worktree is missing.
_Avoid_: orphaned Worktree, missing Topic directory.

**Legacy name hierarchy**:
A Topic family that only the `>` name separator expresses, with no durable Parent Topic data. The
list renders it only while it stays unresolved; it disappears when migration gives every family
durable data.
_Avoid_: Topic name hierarchy, name path.

**Legacy migration**:
The read-only preview and the approved, metadata-only application that move legacy name hierarchies
to durable Parent Topic and Integration Target data. Matching uses the unique same-repository parent
name and ignores Focus; ordering uses unambiguous Git ancestry only. It preserves names, Notes,
Focus, Main Agent references, setup state, Branches, Worktrees, and Repository Recipes, and it never
runs a Git history or Worktree mutation.
_Avoid_: name import, automatic migration.

**Migration journal**:
The private durable record of one legacy migration run under `~/work/migrations/<run-id>/`: the
planned families, the completed families, and one pre-migration manifest backup per touched Topic.
An interrupted run settles at the next daemon start: a family that the journal does not record as
complete returns to its backups.
_Avoid_: migration log, undo history.
