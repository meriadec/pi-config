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
4. Press `a` to add a Topic. Enter its name, `owner/repository`, and Branch. Wizard fields support paste and standard text editing.
5. Select a Topic to open the action rail. The first available action has focus. Press `m` from the Topic list to open or focus its resumable Main Agent directly. Press `o` from the Topic list to focus its i3 workspace directly. Press `p` from the Topic list to open its pull request in a browser.
6. Use the action rail to access the workspace, open a terminal, or select **Start New Main Agent**. A new Main Agent gets an empty Pi session. Its previous session file is kept. When a Topic branch has a pull request, the Topic list shows its number as an underlined `#<number>` link with a progressive status. The status shows the highest-signal condition first: `merged`, `closed`, `draft`, `ci-failing` (checks are red), `reviewing` (a requested reviewer such as Copilot has not submitted yet), `feedback` (an unresolved review thread or a changes-requested review), `checks` (CI still running), `approved`, and finally `clear` (CI is green, no review is pending, and no thread is unresolved). The `PR` column and the **Open Pull Request in Browser** action are present only while a pull request exists.
7. You can also retry setup or delete only the Topic record from the action rail.

The dashboard starts or connects to `pi-workd`. Closing the dashboard does not stop the daemon or Main Agent. Workspace pool exhaustion is informational; close or move a window before you retry.

Running `/new` inside a Main Agent window keeps the window affiliated with its Topic. The window carries a durable, non-secret window affiliation credential, so its new Pi session is adopted as the Topic's live Main Agent. Durable session identity repoints to the adopted session; the previous session file is kept.

After extension development changes, run `/reload` in Pi before you test the new code.

## Architecture and storage

- `client/` contains `/work`, setup, protocol client, and dashboard code.
- `daemon/` contains `pi-workd`, provisioning, policy enforcement, i3/kitty adapters, pull request discovery, and Main Agent leases. It polls the GitHub GraphQL API through `gh` for each ready Topic branch to read the pull request lifecycle, CI rollup, and review threads, and opens the pull request through your browser opener (`xdg-open`).
- `topic-agent/` reports the visible Main Agent lifecycle and heartbeats.
- `shared/` contains schemas, paths, policy resolution, and atomic stores.

The Main Agent starts inside your interactive login shell (`os.userInfo().shell`, or `PI_WORK_SHELL`). Thus your shell aliases load, and job control works: press `Ctrl-Z` to suspend Pi to the shell, then `fg` to resume it.

User data:

- `~/work/config.json` — version 1 configuration and action policies
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

If `/work` cannot connect, confirm that `XDG_RUNTIME_DIR` exists, inspect the two commands above, and check that `gh auth status`, `wt`, `i3-msg`, kitty, and Pi work in the user session. A Topic in `setup-failed` or interrupted `provisioning` can use **Retry Setup**. Restarting the daemon does not make a disconnected Main Agent live; a live agent must register and send heartbeats again.

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
- repository recipes, development servers, Kubernetes, or manual-test recipes
- Delegation Jobs or headless agents
- an LLM-callable control-plane tool
- non-systemd Linux, non-i3 window managers, or non-kitty terminals
- two GitHub repositories with the same repository name under one `WORK_BASE`
