# Work control plane

`work` is a local control plane for durable Topics. The `/work` Pi command opens the dashboard. The `pi-workd` systemd user service owns Topic files, provisioning, desktop actions, Main Agent leases, and live subscriptions.

## Prerequisites

Use Linux with:

- Bun
- `systemd --user`
- GitHub CLI (`gh`)
- `wt`
- i3 and `i3-msg`
- kitty
- Pi

The first `/work` run asks for `WORK_BASE`. This directory contains base checkouts. Configuration is not written into a repository.

The `pi-workd` daemon runs `gh` for repository clone and pull request discovery. The daemon inherits the systemd user manager environment, not your shell. Thus, when the client starts the daemon, it forwards `GH_TOKEN` (and `GITHUB_TOKEN`, if set) from your shell into the user manager with `systemctl --user import-environment`. The value stays in memory and is not written to a file. If you authenticate `gh` through its own configuration (`gh auth login`) instead, the daemon reads that configuration directly and no token forwarding is necessary.

## Use

1. Start Pi in interactive TUI mode.
2. Run `/work`.
3. Set `WORK_BASE` if requested.
4. Press `a` to add a Topic. Enter its name, `owner/repository`, and Branch. Wizard fields support paste and standard text editing. At the repository stage the wizard lists the Known repositories declared in your config; type to fuzzy-match, use `↑`/`↓` to highlight a row, and press `tab` to complete it into the field. `enter` always submits the typed text, so a completion needs the explicit `tab`.
5. Select a Topic to open the action rail. **Copy Branch Name** is the first action and copies the exact Branch name to the system clipboard. Press `n` from the Topic list to add or edit its Topic Note. Press `m` to open or focus its resumable Main Agent directly. Press `o` to focus its i3 workspace directly. Press `p` to open its pull request in a browser. Press `r` to refresh local repository state and start a background pull request refresh. Press `Shift+J` to Unfocus the selected Topic and `Shift+K` to Focus it: Focused Topics stay in the upper part, Unfocused ones sit below a blank separator, and the selection follows the moved Topic. New Topics start Focused.
6. Use the action rail to access the workspace, open a terminal, or select **Start New Main Agent**. A new Main Agent gets an empty Pi session. Its previous session file is kept. When `/track-pr` polls in that session, the Main Agent column shows `tracking-pr` instead of `waiting-for-human`. A parent-owned Delegation Job has the semantic state `thinking-sub`, which the Topic row and detail show as the violet, shimmering label `thinking (sub)`. This state stays on the Topic's parent Main Agent lease; it does not create a child lease or replace the Topic's Main Agent session reference. Display precedence is Main Agent `thinking`, then `thinking (sub)`, then `tracking-pr`, then `waiting-for-human`. When a higher-precedence activity settles, the next live activity becomes visible. A ready Topic whose recorded Worktree directory no longer exists is an Orphan Topic; the Setup column shows `orphan` in bright red. When a Topic branch has a pull request, the Topic list shows its number as an underlined `#<number>` link with a progressive status. The status shows the highest-signal condition first: `merged`, `closed`, `draft`, `ci-failing` (checks are red), `feedback` (an unresolved review thread or a changes-requested review), `checks` (CI still running), `approved` (the formal review decision is approved), `ready` (Copilot reviewed and all threads are resolved), `reviewing` (a requested reviewer has not submitted yet), and finally `clear` (CI is green, no review is pending, and no thread is unresolved). The `PR` column and the **Open Pull Request in Browser** action are present only while a pull request exists.
7. You can also add or edit a Topic Note, rename the Topic, retry setup, or delete only the Topic record from the action rail. With details closed, a Topic Note is shown in yellow in the **Note** column directly after the Topic title; the compact layout keeps it inline. With details open, the list hides the Note and the detail view shows it in the same yellow. A Note is one line and at most 200 characters; saving an empty Note removes it. **Rename Topic** opens a prompt for a new display name; it changes only the Topic name, never its Branch, Worktree, or repository.

Durable Parent Topic data decides the visual family. A family is one level deep, its children
render in Integration Chain order from the Integration Branch end to the Parent Topic end, and a
pending child stays at the position that its Integration Target records. `Shift+J` and `Shift+K`
move the complete family with one keypress and keep the selection. **Add Child Topic** in the side
view of a Parent Topic asks for a name, a Start Point on the Parent Topic Branch, and an optional
Branch; an empty Branch leaves the deterministic name-to-Branch conversion to the daemon. A child
Topic never offers **Add Child Topic**.

The side view also repairs a family without a manifest edit. **Change Parent Topic** and **Move in
Integration Chain** open a chooser: `j`/`k` or `↑`/`↓` move, `enter` applies, and `esc` cancels.
**Change Parent Topic** takes the Topic out of its old chain, inserts it into the new family at the
position that current Git ancestry gives, and adopts the new family's Focus. **Remove Parent Topic**
reconnects the old chain and makes the Topic a root against the repository Integration Branch.
**Move in Integration Chain** detaches one child and inserts it before one chosen chain node; when
current ancestry does not support the new edge, the daemon asks for one confirmation first and the
moved edge then reads Behind or Conflict. **Reset Integration Target** on a Parent Topic rebuilds
the family's chain from current ancestry and refuses an ambiguous family. Deleting an active child
hands its Integration Target to its successor; a Parent Topic with children cannot be deleted.
None of these actions runs fetch, pull, rebase, merge, reset, cherry-pick, or a Branch movement.

The narrow `` column shows local Integration Status: `` Current in green, `` Behind in yellow,
`` Conflict in red, and `` Unknown dim. In a rebase cascade the first yellow or red row is the
next broken edge. Topic detail adds the text status, Integration Target, Integration Branch, ahead
and behind counts, pending chain state, and one bounded diagnostic.

Integration Status is observed from committed local Branch tips only. The daemon reads it when it
starts, when `/work` opens, when you press `r`, and when chain metadata changes. An explicit refresh
first checks Worktree presence and Integration Branches, then Integration Status. It returns this
local result while one single-flight pull request refresh continues in the daemon and publishes
progressive events. Integration Status uses no timer, no file watcher, and no network: `fetch`,
`pull`, `rebase`, `merge`, `reset`, `cherry-pick`, a Branch movement, and a temporary Worktree never
run. The repository Integration Branch is inferred once, when the first Topic of that repository is
created, and is then persisted in `~/work/config.json`. A later Branch switch in the Base checkout
does not change it.

A Topic that durable data does not place keeps the legacy name hierarchy: Topic names can form a
visual hierarchy with the exact `>` separator. When the exact parent Topic exists in the same Focus
part, the list keeps the family together and replaces repeated parent prefixes with tree
connectors. An active child moves its family but stays below its parent. This display does not
change the stored Topic names.

## Migrate legacy name hierarchies

The daemon detects unresolved legacy `>` families at startup by name only. It changes nothing
then. While one such family exists, the side view offers **Migrate Legacy Name Hierarchies**.

The action first asks the daemon for a read-only preview. The preview matches each `>` name to the
unique Topic of the same repository whose name equals the parent part, ignores Focus while matching,
and orders the children only when current Git ancestry gives one unambiguous order. It shows every
proposed Parent Topic and Integration Target, and every skipped Topic with a short reason
(`no-parent-match`, `ambiguous-name-match`, `cross-repository`, `nested-child`, `not-ready`,
`ambiguous-ancestry`). `j`/`k` or `↑`/`↓` scroll, `esc` cancels, and `enter` approves. Nothing is
written before that approval.

An approved run writes Topic metadata only: the Parent Topic link, the Integration Target, and the
active chain state. Names, Notes, Focus, Main Agent references, setup state, Branches, Worktrees, and
Repository Recipes stay unchanged, and no Branch or Worktree command runs. Each family is applied
independently, so an ambiguous family never blocks a safe one. When every legacy family is resolved,
the name-based rendering disappears by itself.

### Backups, journal, and manual restore

Before the first write, the run stores one pre-migration copy of each touched Topic manifest and a
recovery journal:

```text
~/work/migrations/<run-id>/journal.json          # planned and completed families (0600)
~/work/migrations/<run-id>/backup/<topic-id>.json  # pre-migration Topic manifest (0600)
```

Every directory is private (0700) and every file is written atomically with mode 0600. The ten newest
settled runs are kept; older run directories are removed.

A family is written completely or not at all. When a write fails, the run restores that family from
its backups at once and reports it as rolled back. When the daemon is interrupted mid-run, the next
daemon start settles the journal: a family that the journal does not record as complete returns to its
backup manifests, and a completed family stays migrated.

To restore one Topic by hand, stop the daemon and copy the backup back:

```bash
systemctl --user stop pi-workd
cp ~/work/migrations/<run-id>/backup/<topic-id>.json ~/work/topics/<topic-id>/topic.json
systemctl --user start pi-workd
```

The dashboard starts or connects to `pi-workd`. Closing the dashboard does not stop the daemon or Main Agent. Workspace pool exhaustion is informational; close or move a window before you retry.

Running `/new` inside a Main Agent window keeps the window affiliated with its Topic. The window carries a durable, non-secret window affiliation credential, so its new Pi session is adopted as the Topic's live Main Agent. Durable session identity repoints to the adopted session; the previous session file is kept.

After extension development changes, run `/reload` in Pi before you test the new code.

## Create a Topic from Pi or the CLI

The extension registers the `work_topic_create` tool. You can ask Pi, for example:

- `Create a work Topic from HEAD~2 named My contribution.`
- `Create a work Topic for LedgerHQ/revault with Branch foo-bar.`

The tool parameters are `name`, `repository`, `branch`, `startPoint`, `sourceCheckout`, and
`timeoutSeconds`. Only `name` is required. `timeoutSeconds` changes only how long the client waits;
it does not cancel daemon provisioning. The tool creates the Topic and waits for provisioning. It
does not open a desktop workspace, terminal, or Main Agent.

The repository also exposes the `pi-work` executable through its Bun package entry. From this
repository root, install the local command once:

```sh
bun link
```

Make sure Bun's global binary directory is in `PATH`. You can then run the literal command used in
these examples:

```sh
pi-work topic create --name "My contribution" --start-point HEAD~2
pi-work topic create --name "My contribution" \
  --repository LedgerHQ/revault --branch foo-bar
```

Use `--source-checkout <path>` to select a different Source checkout. It defaults to the current
directory. If `--repository` is absent, the client infers `owner/repo` from the Source checkout's
GitHub `origin`. If `--branch` is absent, the client makes a Git-safe Branch from the Topic name.
An explicit repository and Branch do not need a Source checkout when there is no Start Point.
Use `--json` for one versioned result object on stdout. Diagnostics stay on stderr.

A Start Point can be a relative revision, tag, or SHA. The client resolves it to one exact commit.
The Source checkout must be a worktree from the same local clone as the configured Base checkout.
The daemon does not fetch or copy a local-only commit from a separate clone. The Start Point and
Source checkout are creation input only. They are not stored in the Topic manifest.

The daemon applies the configured Action policy. `allow` continues, and `deny` stops. For `ask`,
the Pi tool shows the daemon text in a direct human dialog. An interactive CLI asks for `yes` or
`no`. JSON mode and a non-interactive CLI return `confirmation-required` with exit code 3. They
never approve. The tool has no approval parameter, and the original model request is not approval.

A repository and Branch can belong to only one Topic. A duplicate request returns the existing
Topic identity. If the Branch already exists at another Start Point, creation fails and does not
move the Branch or add a numeric suffix.

Creation progress and errors are bounded. They do not include raw Setup output, credentials, or
the Source checkout after input resolution.
The Pi tool uses the same ten-minute request deadline as the `/work` UI unless `timeoutSeconds` is
given. The CLI waits for at most six hours. A request timeout is reported as `request-timeout`, not
as cancellation. If Pi cancels
the tool call after the daemon request starts, the result gives the last semantic phase and tells
you to check `/work`: daemon provisioning can continue after the tool stops waiting. Check the
existing Topic before you retry with the same repository and Branch.

## Create a child Topic from Pi or the CLI

The extension also registers the `work_topic_create_child` tool for a Topic that continues an
existing Topic from one of its commits. Inside a Parent Main Agent you can ask, for example:

- `Create a child Topic for the first commit of this branch.`

The tool parameters are `name`, `startPoint`, `parentTopicId`, `branch`, `sourceCheckout`, and
`timeoutSeconds`. `name` and `startPoint` are required. The Parent Topic comes from the
`PI_WORK_TOPIC_ID` of a Parent Main Agent session; supply `parentTopicId` only outside such a
session, where a missing Parent Topic is a direct error. Omit `branch` to let the same Topic-name
conversion make the Branch; an explicit Branch is kept exactly after normal Git validation.

The same operation is available from the CLI:

```sh
pi-work topic create-child --name "Widen the note column" --start-point HEAD~1
pi-work topic create-child --name "Widen the note column" \
  --start-point 0f1e2d3 --parent-topic-id <topic-id> --branch keep-this-name
```

The Start Point is resolved to one exact commit in the Source checkout with the same local Git
safety rules as normal creation. Confirmation, cancellation, timeout, progress, JSON output, and
bounded errors behave exactly as they do for normal creation. Read the selected commit before you
choose a name, so the Topic name describes the change instead of a SHA or a commit position.

## Architecture and storage

- `client/` contains `/work`, setup, protocol client, and dashboard code.
- `daemon/` contains `pi-workd`, provisioning, policy enforcement, i3/kitty adapters, pull request discovery, and Main Agent leases. It polls the GitHub GraphQL API through `gh` for each ready Topic branch to read the pull request lifecycle, CI rollup, and review threads, and opens the pull request through your browser opener (`xdg-open`).
- `topic-agent/` reports the visible Main Agent lifecycle and heartbeats.
- `shared/` contains schemas, paths, policy resolution, and atomic stores.

## Repository Recipes

A **Repository Recipe** is an ordered list of **Setup commands** declared for one
`owner/repo` repository. When a Topic gets a freshly created Worktree, the daemon runs
the Recipe once, line by line, to prepare that Worktree. A Recipe does not run when the
Worktree already exists, and a Topic that fails a Setup command goes to `setup-failed`;
**Retry Setup** re-runs the whole Recipe from the top, so keep Setup commands safe to
re-run.

Declare Recipes by hand in `~/work/config.json` under a top-level `repositories` map:

```json
{
  "version": 1,
  "repositories": {
    "LedgerHQ/revault": {
      "setupCommands": [
        "pnpm install",
        "pnpm build --filter @ledgerhq/revault-sdk",
        "cp ./packages/web/.env.sample ./packages/web/.env"
      ]
    }
  }
}
```

Each Setup command is one full shell line, run through your login shell (`-lc`) in the
Worktree, with the daemon environment. Each command has a 5-minute deadline and bounded
captured output. The list view shows a live `setup N/M` phase while the Recipe runs. The
`topic.run-setup` Action gates the Recipe through the usual `allow` / `ask` / `deny`
policy (default `allow`).

### Base checkout override

By default a repository's Base checkout lives at `WORK_BASE/<repo-name>`. To keep a
repository outside `WORK_BASE` — for example to work on an existing local clone such as
`~/.pi` — declare an absolute `basePath` in the same repository entry:

```json
{
  "version": 1,
  "repositories": {
    "meriadec/pi-config": { "basePath": "/home/you/.pi" }
  }
}
```

With `basePath` set, the daemon uses that checkout as the Base checkout for every Topic of
`meriadec/pi-config`. When the path already holds a matching clone, the daemon adopts it
and does not clone. `setupCommands` is optional in an entry that only overrides the
location. The path must be absolute and its Git origin must match the Topic's `owner/repo`.

The Main Agent starts inside your interactive login shell (`os.userInfo().shell`, or `PI_WORK_SHELL`). Thus your shell aliases load, and job control works: press `Ctrl-Z` to suspend Pi to the shell, then `fg` to resume it. For zsh and bash, the window runs Pi from a private, per-Topic startup file under `$XDG_RUNTIME_DIR/pi-work-shell/` so that a suspend drops to an interactive prompt in the same window instead of closing it. Other shells fall back to a `-c` launch that does not keep job control.

User data:

- `~/work/config.json` — version 1 configuration, action policies, and Repository Recipes
- `~/work/affiliations.json` — durable, non-secret window-affiliation credentials so a live Main Agent window re-attaches after a daemon restart
- `~/work/topics/<topic-id>/topic.json` — one durable Topic manifest
- `$XDG_RUNTIME_DIR/pi-workd.sock` — private Unix socket
- `~/.config/systemd/user/pi-workd.service` — generated user service unit

`~/work`, Topic directories, manifests, and the socket use private permissions. Do not put credentials or session content in Topic names, Topic Notes, or configuration.

## Operate the service

Inspect status and bounded daemon errors:

```sh
systemctl --user status pi-workd
journalctl --user -u pi-workd
```

Restart the daemon and let it reconcile durable Topics:

```sh
systemctl --user restart pi-workd
```

If `/work` cannot connect, confirm that `XDG_RUNTIME_DIR` exists, inspect the two commands above, and check that `gh auth status`, `wt`, `i3-msg`, kitty, and Pi work in the user session. A Topic in `setup-failed` or interrupted `provisioning` can use **Retry Setup**. After a daemon restart, a Main Agent window that is still open re-attaches by itself: it holds a durable, non-secret window-affiliation credential (stored in `~/work/affiliations.json`), so its next heartbeat reconnects and adopts its live session. The Topic returns from `stopped` to its live state without any action. If the window was already closed, the Topic stays `stopped` until you start a new Main Agent.

To uninstall only the generated service and socket safely:

```sh
systemctl --user disable --now pi-workd.service
rm -f ~/.config/systemd/user/pi-workd.service
rm -f "$XDG_RUNTIME_DIR/pi-workd.sock"
systemctl --user daemon-reload
```

Do not delete `~/work`, repositories, base checkouts, worktrees, branches, Pi sessions, or open windows as part of service uninstall.

### Repair an Integration Chain

The daemon never repairs Git history for you. Use these steps when the `` column is not green.

1. Refresh first: open `/work` or press `r`. The status comes from committed local Branch tips, so
   an old value disappears as soon as the daemon reads Git again.
2. Repair the cascade from the top. The first yellow (` Behind) or red (` Conflict) row is the
   next broken edge; Topic detail names its Integration Target. Rebase that Topic Branch by hand in
   its own Worktree, then refresh:

   ```sh
   cd <worktree of the first broken Topic>
   git rebase <Integration Target branch>
   ```

   Each repaired edge moves the cascade one step further, up to the Parent Topic.

3. `` Unknown always states its reason in Topic detail:
   - _Topic setup is not finished_: use **Retry Setup**.
   - _The recorded Worktree of this Topic is missing_: the Topic is an Orphan Topic; **Retry Setup**
     creates its Worktree again.
   - _Insertion into the Integration Chain is still pending_: setup finished, but current ancestry
     did not give one position. **Retry Setup** finishes the insertion once the Parent Branch
     contains the child Branch again; **Move in Integration Chain** places it explicitly.
   - _The repository has no Integration Branch yet_: add `"integrationBranch": "<branch>"` to that
     repository entry in `~/work/config.json` and refresh.
   - _The Integration Target Topic is missing or not ready_: repair that Topic first, or use
     **Reset Integration Target** on the Parent Topic to rebuild the family chain from ancestry.
4. After a manual rebase that changed which Branch contains which, use **Reset Integration Target**
   on the Parent Topic. It refuses a family whose ancestry gives no single order; in that case use
   **Move in Integration Chain** for the one child that is out of place.

An interrupted legacy migration needs no manual step: the next daemon start settles its journal.
Restore one Topic manifest by hand only as a last resort, with the backup copy documented in
[Backups, journal, and manual restore](#backups-journal-and-manual-restore).

## Version 1 limits

Version 1 does not provide:

- Topic types or lifecycle phases
- GitHub notification ingestion
- pull request creation, monitoring, rebasing, conflict resolution, or commit-stack refinement
- development servers, Kubernetes, or manual-test recipes
- Delegation Jobs or headless agents
- non-systemd Linux, non-i3 window managers, or non-kitty terminals
- two GitHub repositories with the same repository name under one `WORK_BASE`
