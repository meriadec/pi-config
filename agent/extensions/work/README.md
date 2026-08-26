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
5. Select a Topic to open the action rail. The first available action has focus. Press `m` from the Topic list to open or focus its resumable Main Agent directly. Press `o` from the Topic list to focus its i3 workspace directly. Press `p` from the Topic list to open its pull request in a browser. Press `r` to refresh pull request state now, ahead of the daemon poll cadence. Press `Shift+J` to Unfocus the selected Topic and `Shift+K` to Focus it: Focused Topics stay in the upper part, Unfocused ones sit below a blank separator, and the selection follows the moved Topic. New Topics start Focused.
6. Use the action rail to access the workspace, open a terminal, or select **Start New Main Agent**. A new Main Agent gets an empty Pi session. Its previous session file is kept. When `/track-pr` polls in that session, the Main Agent column shows `tracking-pr` instead of `waiting-for-human`. A parent-owned Delegation Job has the semantic state `thinking-sub`, which the Topic row and detail show as the violet, shimmering label `thinking (sub)`. This state stays on the Topic's parent Main Agent lease; it does not create a child lease or replace the Topic's Main Agent session reference. Display precedence is Main Agent `thinking`, then `thinking (sub)`, then `tracking-pr`, then `waiting-for-human`. When a higher-precedence activity settles, the next live activity becomes visible. A ready Topic whose recorded Worktree directory no longer exists is an Orphan Topic; the Setup column shows `orphan` in bright red. When a Topic branch has a pull request, the Topic list shows its number as an underlined `#<number>` link with a progressive status. The status shows the highest-signal condition first: `merged`, `closed`, `draft`, `ci-failing` (checks are red), `feedback` (an unresolved review thread or a changes-requested review), `checks` (CI still running), `approved` (the formal review decision is approved), `ready` (Copilot reviewed and all threads are resolved), `reviewing` (a requested reviewer has not submitted yet), and finally `clear` (CI is green, no review is pending, and no thread is unresolved). The `PR` column and the **Open Pull Request in Browser** action are present only while a pull request exists.
7. You can also rename the Topic, retry setup, or delete only the Topic record from the action rail. **Rename Topic** opens a prompt for a new display name; it changes only the Topic name, never its Branch, Worktree, or repository.

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

`~/work`, Topic directories, manifests, and the socket use private permissions. Do not put credentials or session content in Topic names or configuration.

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

## Version 1 limits

Version 1 does not provide:

- Topic types or lifecycle phases
- GitHub notification ingestion
- pull request creation, monitoring, rebasing, conflict resolution, or commit-stack refinement
- development servers, Kubernetes, or manual-test recipes
- Delegation Jobs or headless agents
- non-systemd Linux, non-i3 window managers, or non-kitty terminals
- two GitHub repositories with the same repository name under one `WORK_BASE`
