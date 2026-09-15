# Work control plane

`work` is a local control plane for durable Topics: named units of work, each on a Branch of a
GitHub repository, with a provisioned worktree and a resumable Main Agent.

## Language

**Topic**:
A durable unit of work bound to one `owner/repo` repository and one Branch, with its own Worktree and Main Agent.

**Topic Note**:
A durable, optional free-text annotation on one Topic. It gives human context without changing the Topic's name, identity, hierarchy, Partition, or sort order.
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
The optional full-feature Topic that contains a child checkpoint Topic. It owns visual hierarchy and Partition membership for the family; a child cannot itself be a Parent Topic.
_Avoid_: parent branch, epic, group.

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

**Git Operation State**:
The current rebase, merge, cherry-pick, or revert state of a Topic Worktree. It is observed local
state, separate from the committed Integration Status and the durable Setup State.
_Avoid_: Integration Status, Setup State.

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

**Durable Operation**:
A control-plane request whose accepted work and result survive client disconnection and daemon restart. Topic provisioning is a Durable Operation.
_Avoid_: background task, request, job.

**Operation Handle**:
The stable identity returned after the daemon accepts a Durable Operation. A client uses it to observe, resume waiting for, or cancel that operation without owning its lifetime.
_Avoid_: request ID, process ID, job ID.

**Interrupted Setup**:
A Setup attempt whose running command lost supervision before its success was known. It needs an explicit Retry Setup and is never resumed or skipped automatically.
_Avoid_: failed command, cancelled setup.

**Atomic Command**:
A short control-plane mutation committed as one durable state change. Repeating the same client and request identity returns the original result rather than applying the mutation again.
_Avoid_: Durable Operation, action, transaction.

**Ephemeral Action**:
A control-plane request whose useful lifetime ends when its client or daemon run ends, such as focusing a window or refreshing observed state.
_Avoid_: Durable Operation, command.

**Topic hierarchy**:
The durable one-level family formed by Parent Topic relationships. The list shows checkpoint Topics
below their full Parent Topic with tree connectors. A family's active Main Agents move the family
together, but a child never moves above its parent. Topic names do not define or change this
hierarchy.
_Avoid_: Topic name hierarchy, name path.

**Partition**:
A durable ordered part of the dashboard Topic list. Each complete Topic family belongs to one Partition.
_Avoid_: Focus, group, section, lane.

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

**Private local capability**:
A bearer value that authorizes one same-user local process to claim a bounded Work privilege, such as Main Agent registration or window affiliation. Its raw value is not durable state and must not appear in logs, errors, snapshots, or backups.
_Avoid_: non-secret credential, identity token.

**Pull Request identity**:
The durable GitHub pull request number that a Topic records after it first associates the pull request
with its Branch. The daemon uses this identity to continue showing the pull request after it becomes
merged or closed and after the daemon restarts. For an older Topic without this identity, the daemon
accepts a terminal pull request only when its final head commit is the local Topic Branch tip.
_Avoid_: pull request status, branch lookup.

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
