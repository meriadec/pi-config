# Work control plane

Work is a local Effect control plane for durable Topics. The `/work` command opens the dashboard. The `pi-workd` systemd user service owns SQLite state, durable operations, desktop actions, Main Agent leases, and revisioned subscriptions.

## Requirements

Use Linux with:

- Bun
- `systemd --user`
- Git and GitHub CLI (`gh`)
- Worktrunk (`wt`)
- i3 and `i3-msg`
- kitty
- Pi

The daemon runs `gh` for repository clone and pull request observation. It inherits the systemd user-manager environment. When the client starts the daemon, it forwards `GH_TOKEN` and `GITHUB_TOKEN`, when set, with `systemctl --user import-environment`. The values stay in memory. If you use `gh auth login`, the daemon uses the GitHub CLI configuration instead.

## Dashboard

Start Pi in TUI mode and run `/work`. The dashboard connects to the daemon through Effect RPC and shows the durable Topics with their repository, Branch, setup state, and Main Agent state.

- Press `r` to refresh observations.
- Press `q` or `Q` to close Topic details. Press `esc` or `ctrl-c` to close the dashboard.

Closing the dashboard closes its client runtime. It does not stop the daemon or a Main Agent.

Durable Parent Topic and Integration Target data define each one-level Topic family and its Integration Chain. Partition numbers define the primary display order. The daemon calculates Integration Status from committed local Branch tips. Git and GitHub observations are cache data and are rebuilt after daemon restart.

Topic details show the exact Integration Branch as `configured` or `inferred`. **Reset Integration Branch** is available only for inferred repository state. Its direct confirmation names the repository. Reset removes only the stored inference, then refreshes local status so a safe observation can infer it again. It does not move a Branch or change Git history. An explicit `integrationBranch` configuration always wins and cannot be reset from the dashboard.

After extension changes, run `/reload` in Pi. Restart the daemon when daemon code changes:

```sh
systemctl --user restart pi-workd
```

## Create Topics

The extension registers these tools:

- `work_topic_create`
- `work_topic_create_child`

A root Topic accepts `name`, `repository`, `branch`, `startPoint`, `sourceCheckout`, and `timeoutSeconds`. Only `name` is required. With an explicit repository and no Start Point, no Source checkout is necessary. Otherwise, the client uses the Source checkout to infer the GitHub repository or resolve the Start Point.

A child Topic accepts `name`, `startPoint`, `parentTopicId`, `branch`, `sourceCheckout`, and `timeoutSeconds`. `name` and `startPoint` are required. In a Parent Main Agent session, `PI_WORK_TOPIC_ID` supplies the Parent Topic when `parentTopicId` is absent.

The client resolves a Start Point to one exact commit before it starts the Durable Operation. It verifies that a child Start Point belongs to the Parent Topic Branch. If `branch` is absent, it makes a Git-safe Branch from the Topic name.

Tool and CLI waits do not own the operation. A timeout or disconnected client stops only the wait. Use the Operation Handle to inspect the durable result.

## CLI

The package exposes `pi-work`. From the repository root, install the local command once:

```sh
bun link
```

Create Topics:

```sh
pi-work topic create --name "My contribution" --start-point HEAD~2
pi-work topic create --name "My contribution" \
  --repository LedgerHQ/revault --branch foo-bar
pi-work topic create-child --name "Continue the change" \
  --start-point HEAD~1 --parent-topic-id <topic-id>
```

Use `--source-checkout <path>` to select a different checkout. Use `--json` for one versioned JSON result on stdout. An interactive CLI shows the exact daemon request and accepts `yes` or `no`. JSON and non-interactive use do not approve an `ask` policy. They return `confirmation-required` with exit status 3.

The CLI keeps its six-hour client wait. A wait timeout returns status 124, and Ctrl-C returns status 130. A policy denial or direct rejection returns status 4. Timeout, Ctrl-C, and disconnect stop only the client wait. They do not cancel accepted daemon work; use the Operation ID to inspect it.

Inspect and cancel operations:

```sh
pi-work operation list
pi-work operation show <operation-id>
pi-work operation cancel <operation-id> --confirm
```

Cancellation needs the direct `--confirm` flag. It requests cancellation of the Durable Operation and does not only stop a client wait.

Manage backups:

```sh
pi-work storage backup
pi-work storage verify <absolute-backup-path>
systemctl --user stop pi-workd
pi-work storage restore <absolute-backup-path> --confirm
```

Restore requires a stopped daemon and an explicit private backup path.

## Configuration

`~/work/config.json` is a strict, human-authored version 2 file. Unknown fields and old versions fail validation. A normal read does not rewrite the file.

Example:

```json
{
  "version": 2,
  "workBase": "/home/you/worktrees",
  "policies": {
    "defaults": {
      "repository.clone": "allow",
      "topic.create-worktree": "allow",
      "topic.run-setup": "allow",
      "terminal.open": "allow",
      "agent.open": "ask",
      "agent.reset": "ask",
      "topic.delete": "ask"
    },
    "repositories": {},
    "topics": {}
  },
  "repositories": {
    "LedgerHQ/revault": {
      "integrationBranch": "main",
      "setupCommands": ["pnpm install"]
    }
  }
}
```

A repository entry can set an absolute `basePath` when its Base checkout does not use `WORK_BASE/<repository-name>`.

Repository Recipe Setup commands run through the configured login shell in the Topic Worktree. Each command has bounded output and a bounded duration. Retry Setup starts a new attempt from command one, so commands must tolerate repeated execution.

Policy values are `allow`, `ask`, and `deny`. Direct confirmation is necessary for an `ask` decision. Private capabilities must not be put in configuration, logs, Topic names, Notes, or Setup commands.

## Storage and architecture

The final control plane has these module groups:

- `domain/`: schemas, brands, immutable values, and typed failures
- `application/`: commands, durable operations, state projection, observation, provisioning, and Main Agent lifecycle
- `infrastructure/`: SQLite, Effect RPC, process, Git, GitHub, desktop, concurrency, and storage maintenance adapters
- `client/`: the dashboard runtime, generated RPC client bridge, tools, CLI, and systemd manager
- `daemon/`: the scoped production application and RPC server
- `topic-agent/`: lazy Topic Agent environment and telemetry adapters

Authoritative paths:

- `~/work/config.json`: strict configuration
- `~/work/work.db`: authoritative Topic, operation, capability-hash, and repository state
- `~/work/backups/`: private verified backup bundles
- `$XDG_RUNTIME_DIR/pi-workd.sock`: private Effect RPC socket
- `$XDG_RUNTIME_DIR/pi-workd.lock`: daemon lifetime lock
- `~/.config/systemd/user/pi-workd.service`: generated user service

The original private import backup is evidence and must stay unchanged. The running application reads only SQLite and the strict configuration.

Raw SQL stays in storage infrastructure. Child processes stay in process infrastructure. Long-lived work has an Effect Scope owner. The RPC stream starts with a full snapshot, then sends revisioned semantic changes. A slow client cannot block state changes.

## Service operation

Inspect status and bounded daemon errors:

```sh
systemctl --user status pi-workd
journalctl --user -u pi-workd
```

Restart and reconcile durable state:

```sh
systemctl --user restart pi-workd
```

If `/work` cannot connect:

1. Confirm that `XDG_RUNTIME_DIR` exists.
2. Inspect the service status and journal.
3. Check `gh auth status`, `wt`, `i3-msg`, kitty, and Pi in the user session.
4. Run `pi-work storage verify <backup-path>` when storage evidence is under review.

A Topic in `setup-failed` or `setup-interrupted` can start a new setup attempt. After daemon restart, an open Main Agent reattaches with its private affiliation capability. Capability hashes and durable Main Agent identity are in SQLite. Live activity is observed again.

To remove only the generated service and socket:

```sh
systemctl --user disable --now pi-workd.service
rm -f ~/.config/systemd/user/pi-workd.service
rm -f "$XDG_RUNTIME_DIR/pi-workd.sock"
systemctl --user daemon-reload
```

Do not delete `~/work`, backups, repositories, Worktrees, Branches, Pi sessions, or open windows as part of service removal.
