# Work control plane

`work` is a local control plane for durable Topics: named units of work, each on a Branch of a
GitHub repository, with a provisioned worktree and a resumable Main Agent.

## Language

**Topic**:
A durable unit of work bound to one `owner/repo` repository and one Branch, with its own worktree
and Main Agent. Stored as a manifest under `~/work/topics/<topic-id>/topic.json`.

**Base checkout**:
The single clone of a repository, shared by all Topics of that repository. By default it lives
at `WORK_BASE/<repo-name>`. A **Base checkout override** (`basePath` in a repository entry of
`~/work/config.json`) puts it at a fixed absolute path outside `WORK_BASE` instead, so a Topic can
adopt an existing checkout (for example `~/.pi`).

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

**Known repository**:
An `owner/repo` repository already declared in `~/work/config.json` (a key of the Repository
Recipe map). The set of Known repositories is offered as fuzzy-matched completions when you name a
Topic's repository in the add-topic wizard.
_Avoid_: saved repo, configured repo.
