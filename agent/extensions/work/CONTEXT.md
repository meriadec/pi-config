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
The exact Git commit from which a new Topic Branch starts. It is creation input and is not stored
in the Topic manifest. An existing Branch is accepted only when its tip is this commit.
_Avoid_: base branch, source branch, starting branch.

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

**Topic name hierarchy**:
A visual family inferred when exact Topic names form paths separated by `>`. The exact parent must
exist in the same Focus part. The list shows descendants below their parent with tree connectors and
hides the repeated parent prefix. A family's active Main Agents move the family together; they never
move a child above its parent. This hierarchy does not change stored Topic names or create a durable
relationship.

**Focus**:
The durable follow-state of a Topic: **Focused** (the upper part) or **Unfocused** (the lower part,
below a blank separator). A per-Topic attribute, not a container — the two on-screen
lists are only a rendering of this one state. Focus is the dominant sort key. Within each part,
Topic name hierarchy families stay together. A family with an active Main Agent comes before an
inactive family; active descendant subtrees come before inactive sibling subtrees, and names break
ties. Toggled from the list with Shift+K (Focus) and Shift+J (Unfocus), each an idempotent state-set;
selection follows the moved Topic. A Topic with no recorded state is Focused, so new Topics and
Topics from older manifests start Focused.
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
