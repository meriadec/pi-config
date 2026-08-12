# Work Control Plane

Status: approved

## Problem

Personal work is split across many repositories, worktrees, i3 workspaces, terminals, Pi sessions, and pull requests. The costly part is not always the engineering task. It is remembering what is running, where it is running, and which subject needs attention.

`work` is a local control plane for durable topics. A topic connects one subject to its repository, `wt` worktree, temporary i3 workspace, kitty windows, and one interactive main agent.

## Goals

Version 1 must:

1. Open a full-screen control-plane UI with `/work`.
2. Keep control-plane state alive after the Pi session that opened `/work` exits.
3. Store all user configuration in `~/work/config.json`.
4. Store each topic in `~/work/topics/<topic-id>/topic.json`.
5. Create a missing base checkout and let `wt` create and locate the worktree.
6. Show all topics and their live setup and main-agent state.
7. Allocate empty i3 workspaces for topic windows without treating exhaustion as an error.
8. Open topic terminals and one resumable main Pi agent.
9. Recover safely after interrupted setup, process failure, and restart.
10. Put side effects behind action-specific `allow`, `ask`, or `deny` policies.

## Non-goals for version 1

- Topic types and lifecycle phases
- GitHub notification ingestion
- Pull request creation or babysitting
- Rebase, conflict resolution, or commit-history refinement
- Repository setup recipes, development servers, Kubernetes, or manual-test recipes
- Delegation Jobs or headless agents
- An LLM-callable control-plane tool
- Support for non-systemd Linux, non-i3 window managers, or non-kitty terminals
- Two GitHub repositories with the same repository name under one `WORK_BASE`

## Ubiquitous language

### Topic

A durable personal subject. It has a generated ID, user-visible name, Branch, GitHub repository, setup state, and `wt`-reported worktree path.

### Base checkout

The checkout at `<WORK_BASE>/<repo-name>` from which `wt` commands run. It is not a topic worktree.

### Topic worktree

The worktree created or found by `wt switch --create <branch>`. `work` never computes its path or duplicates the configured `wt` naming convention.

### Control plane

The combined `workd` daemon and `/work` client experience.

### Main agent

The one resumable, interactive Pi session associated with a topic. It runs visibly in kitty. It is not a Delegation Job.

### Topic workspace

A temporary lease on an i3 workspace that currently contains windows marked for one topic.

### Action policy

The effective `allow`, `ask`, or `deny` decision for a named side effect. Resolution order is topic override, repository override, then global default.

## Architecture

Implement a deep TypeScript extension module:

```text
agent/extensions/work/
├── index.ts
├── client/
├── daemon/
├── topic-agent/
└── shared/
```

`index.ts` registers `/work`. In a normal Pi session, it acts as the dashboard client. When topic environment variables are present, it also reports main-agent lifecycle events.

`workd` runs as a systemd user service. It owns topic writes, external operations, live process state, and client subscriptions. It listens on a Unix socket below `$XDG_RUNTIME_DIR`. The UI is replaceable and does not contain Git, `wt`, i3, kitty, or persistence logic.

The protocol uses versioned newline-delimited JSON messages. Requests have IDs and receive one response. Subscribed clients also receive bounded semantic events. Unknown message versions and actions fail clearly.

## Configuration

`~/work/config.json` is the only configuration file. Company repositories must not receive `work` configuration.

An initial shape is:

```json
{
  "version": 1,
  "workBase": "/home/user/ledger",
  "policies": {
    "defaults": {
      "repository.clone": "allow",
      "topic.create-worktree": "allow",
      "terminal.open": "allow",
      "agent.open": "allow",
      "topic.delete": "ask"
    },
    "repositories": {},
    "topics": {}
  }
}
```

The model must permit later repository recipes without creating per-repository configuration files. Unknown fields must not be destroyed by a read/write cycle.

If `workBase` is absent, `/work` shows setup before the main view. The selected directory is validated and saved atomically.

## Topic persistence

Each topic has an opaque generated ID and a manifest:

```json
{
  "version": 1,
  "id": "uuid",
  "name": "VG-31025",
  "branch": "feat/VG-31025_tokenization",
  "repository": "LedgerHQ/revault",
  "setup": {
    "state": "provisioning",
    "repositoryAvailable": false,
    "worktreeCreated": false
  },
  "worktreePath": null,
  "mainAgent": {
    "sessionId": "uuid",
    "sessionFile": null
  },
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

Manifests are schema-validated and written with atomic replace semantics. Corrupt manifests do not prevent other topics from loading. The topic snapshot reports a concise diagnostic for each rejected manifest.

Transient state such as socket connections is not written as if it were durable truth. On startup, `workd` reconciles persisted claims with repositories, `wt`, i3, and connected main agents.

## Topic creation

The wizard asks for:

- Name
- Repository in `owner/repo` form
- Branch, with an editable generated default

Topic type is deferred.

Creation is a durable operation:

1. Persist the topic as `provisioning`.
2. Resolve `<WORK_BASE>/<repo-name>`.
3. If it exists, verify that `origin` identifies the requested GitHub repository.
4. If absent, run `gh repo clone <owner>/<repo> <WORK_BASE>/<repo-name>`.
5. Run `wt switch --create <branch> --format json` from the base checkout.
6. Parse and validate the worktree path returned by `wt`.
7. Persist the topic as `ready`.

Failures produce `setup-failed` with a concise reason. Retry reconciles actual state and resumes idempotently. Rollback never deletes a successfully cloned base checkout.

## Topic and main-agent states

Setup state:

- `provisioning`
- `ready`
- `setup-failed`

Main-agent state:

- `starting`
- `thinking`
- `idle`
- `waiting-for-human`
- `stopped`
- `failed`

State rules:

- Process launch starts as `starting`.
- A connected blank Pi session is `idle`.
- `agent_start` reports `thinking`.
- After `agent_settled`, an assistant turn awaiting the next user action reports `waiting-for-human`.
- A normal disconnect reports `stopped`.
- Launch failure, protocol failure, or an unexpected lost heartbeat reports `failed` with a bounded reason.

The dashboard displays setup and agent state separately. It must not pretend that an inferred state is exact.

## i3 and kitty behavior

Workspaces `1` through `10` are a temporary pool.

- Find a topic workspace from i3 marks, not only from a stored number.
- If topic windows exist, open or focus actions use their current workspace.
- Otherwise, select the lowest workspace with no windows.
- Mark topic windows so moving them updates the effective topic workspace.
- When the final marked window closes, the lease ends naturally.
- If no workspace is empty, return a successful `unavailable` result with a clear message. Do not throw an operational error.

Kitty commands include `--single-instance --instance-group i3` and start in the topic worktree. All child-process calls use argument arrays, timeouts, bounded output, and no shell interpolation.

## Main-agent launch

A topic has at most one main agent.

- If its marked window exists, focus it.
- Otherwise launch kitty in the topic workspace and start Pi in the topic worktree.
- Use the topic ID as a deterministic Pi session ID and set a useful session name.
- Pass the topic ID and socket location through explicit environment variables.
- Resume the same session on later launches.
- The topic-aware Pi extension registers with `workd`, reports its session file, sends heartbeats, and reports lifecycle events.

Normal topic terminals are not main agents and do not report Pi lifecycle state.

## `/work` interaction

The full-screen view contains:

- A topic table
- Setup and agent state columns
- A concise status/message area
- A selected-topic detail sidebar
- Discoverable key hints

Required controls:

- `j`/`k` and Down/Up move vertically.
- `h`/`l` and Left/Right move between list, detail, and action areas.
- Enter selects or invokes the focused action.
- `q` closes the details sidebar and returns focus to the Topic list.
- Escape exits `/work` immediately from the normal dashboard, including when details are open.
- Add opens the topic wizard.

Minimum detail actions:

- Access topic workspace
- Open terminal
- Open main agent
- Retry setup when setup failed
- Delete topic with policy enforcement and confirmation

The UI subscribes to daemon events and requests render after semantic state changes. It cleans up its socket and subscription when closed or when the Pi session shuts down.

## Safety and security

- The Unix socket is user-only.
- The daemon accepts only the current user.
- Paths from manifests and subprocess output are validated before use.
- Repository remote comparison normalizes common SSH and HTTPS GitHub forms.
- No credentials, GitHub tokens, Pi auth, or session contents enter topic manifests or logs.
- Logs contain bounded errors and action metadata, not command transcripts by default.
- Action policy is checked in the daemon immediately before the side effect. UI gating alone is insufficient.
- `deny` rejects the action. `ask` returns a confirmation requirement to an interactive client. `allow` proceeds.

## Testing strategy

- Unit-test schemas, policy inheritance, atomic persistence, remote normalization, command-result parsing, state transitions, and protocol framing.
- Use injected process runners and temporary directories. Unit tests must not call real `gh`, `wt`, i3, kitty, systemd, or Pi.
- Test daemon/client behavior with a temporary Unix socket.
- Test TUI reducers and rendering independently from a real terminal.
- Add focused integration tests for topic creation and live agent state with fake adapters.
- Keep output bounded and ensure all created timers, sockets, servers, and child processes are cleaned up.
- Run `bun run check` for each implementation issue.

## Delivery order

The files under `issues/` define an ordered vertical implementation. Each issue must leave the repository type-safe and tested. Ralph Loop must run them in numeric order.

## Acceptance scenario

On a machine where no configuration exists:

1. `/work` asks for `WORK_BASE` and saves it.
2. The user adds `VG-31025`, enters Branch `feat/VG-31025_tokenization`, and selects `LedgerHQ/revault`.
3. `workd` validates or clones the base checkout and invokes `wt` with the Branch.
4. The dashboard shows the Topic as ready using the path returned by `wt`, such as `/home/mpillet/ledger/revault.feat-VG-31025_tokenization` for the configured `wt` convention.
5. Open Terminal leases an empty i3 workspace and opens kitty there.
6. Open Main Agent opens or focuses one resumable Pi session in that workspace.
7. The dashboard changes live between starting, thinking, and waiting-for-human.
8. Closing the dashboard does not stop `workd` or the main agent.
9. Reopening `/work` restores the topic and current observable state.
10. When all workspaces contain windows, Open Terminal reports that no workspace is available without presenting a failure.
