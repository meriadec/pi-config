# Effect v4 Work control plane

Status: accepted

## Summary

Rewrite the Work extension as an Effect v4 control plane. Preserve the useful Work experience, replace daemon-owned JSON state with SQLite, replace the custom protocol with Effect RPC, and make asynchronous work scoped, typed, observable, bounded, and restart-safe.

A one-time, human-verified migration preserves existing Topics. After cutover, remove the importer, old stores, custom protocol, Promise orchestration, and Legacy name hierarchy feature.

## Read first

Implementation issues must use these sources:

- `AGENTS.md`
- `agent/extensions/work/CONTEXT.md`
- `CONTEXT.md`
- `docs/adr/0001-separate-topic-hierarchy-and-integration-chain.md`
- `docs/adr/0002-allow-guarded-explicit-topic-rebases.md`
- `docs/adr/0003-use-effect-v4-for-work-control-plane.md`
- `docs/adr/0004-store-work-state-in-sqlite.md`
- `docs/adr/0005-use-effect-rpc-operation-handles.md`
- `docs/adr/0006-retire-legacy-topic-name-hierarchy.md`
- `agent/extensions/work/README.md`

When an issue changes a documented behavior, update the README and glossary in that issue. Keep implementation details out of `CONTEXT.md`.

## Baseline

At planning time, Work has:

- 15,798 production TypeScript lines
- 13,059 test TypeScript lines
- 436 passing focused tests
- a 2,489-line `TopicService`
- a 2,456-line dashboard model and renderer
- manual Promise queues, timers, socket ownership, request correlation, and detached asynchronous work
- JSON files for Topic, configuration, affiliation, and migration state

The baseline commands are:

```sh
bun run typecheck
bun test agent/extensions/work agent/extensions/sub/topic-integration.test.ts
bun run check
```

The rewrite must keep the branch green after each implementation issue.

## Goals

1. Make every long-lived resource have one visible Effect `Scope` owner.
2. Make all background work supervised and interruptible.
3. Make expected failures typed and defects visible.
4. Make daemon-owned durable changes atomic and recoverable.
5. Make command retries idempotent across client and daemon restarts.
6. Keep pure planning code pure.
7. Replace shallow infrastructure interfaces with deep modules.
8. Preserve existing Topics through a verified migration.
9. Preserve the current dashboard experience and useful Work interfaces.
10. End with no old storage, protocol, lifecycle, or Legacy name hierarchy implementation.

## Non-goals

- support another operating system, init system, window manager, or terminal
- replace Git, GitHub CLI, Worktrunk, i3-msg, kitty, or the browser opener
- redesign the dashboard product experience
- add OTLP export
- migrate the complete `sub` extension
- add an ORM
- keep compatibility aliases or an old private protocol
- wrap deterministic domain functions in Effect without a side-effect reason

## Product compatibility

Keep:

- `/work`
- `work_topic_create`
- `work_topic_create_child`
- Topic Agent `PI_WORK_*` environment meanings
- Delegation Job removal of all Topic Agent capabilities
- current dashboard keys, layout behavior, actions, and status meanings
- `pi-work topic create` and `pi-work topic create-child`
- policy semantics
- Topic creation, child creation, Partitions, Notes, Main Agent control, pull request observation, Integration Status, chain maintenance, guarded rebase, Worktree recovery, and Repository Recipes

Permit:

- a new private RPC protocol
- a new protocol version
- a new CLI JSON output version
- new operation and storage CLI commands
- removal of the Legacy name hierarchy feature after migration

Add:

- `pi-work operation list`
- `pi-work operation show <operation-id>`
- `pi-work operation cancel <operation-id>`
- temporary `pi-work storage migrate` until the verified cutover is complete
- `pi-work storage backup`
- `pi-work storage verify`
- `pi-work storage restore <backup-path>`
- dashboard **Cancel Setup** for active provisioning
- dashboard **Reset Integration Branch** for inferred Integration Branch state

## Dependency policy

The initial foundation pins these runtime dependencies exactly:

```json
{
  "effect": "4.0.0-rc.115",
  "@effect/platform-bun": "4.0.0-rc.115",
  "@effect/sql-sqlite-bun": "4.0.0-rc.115"
}
```

They belong in `dependencies`. Use direct imports such as `effect/Effect`; do not use the root `effect` barrel in Work production code.

One late issue checks the current v4 RC, upgrades all Effect packages together when appropriate, and reruns all contract tests. Do not mix an Effect version change with a module migration.

Stable and `effect/unstable/*` modules are permitted after contract tests. If an unstable platform adapter fails a Work requirement, replace it with one custom Effect-native adapter. Do not retain parallel implementations.

## Domain model

### Branded values

Decode and brand these values at external seams:

- Topic ID
- Operation ID
- client ID
- request ID
- Branch
- GitHub repository (`owner/repo`)
- full commit SHA
- absolute path
- protocol version
- storage schema version

Use opaque or redacted values for Private local capabilities. Larger records can be immutable objects; they do not all need to be `Schema.Class` values.

### Work classifications

**Durable Operation**

Accepted work survives client disconnection and daemon restart. Creation and provisioning are Durable Operations.

**Atomic Command**

A short mutation commits as one SQLite state change. Repeating the same client and request identity with the same fingerprint returns the stored result. A different fingerprint fails.

**Ephemeral Action**

Work ends with the client or daemon run. Observation, opening windows, and opening a browser are Ephemeral Actions.

**Rebase exception**

A rebase mutates an external Git repository. Record that it started, but never restart it automatically. After interruption, inspect actual Git Operation State and leave recovery to the human.

### Operation Handle

Starting a Durable Operation returns its stable Operation Handle quickly. Clients use separate RPCs to inspect, watch, await, or request cancellation. Pi tool and CLI adapters can hide this protocol and keep their current wait-for-completion experience.

## Target module shape

The final names can vary, but the dependency direction cannot.

```text
agent/extensions/work/
├── domain/             # schemas, brands, immutable values, pure planning
├── application/        # deep command, operation, state, and lease modules
├── infrastructure/
│   ├── storage/        # Effect SQL repositories, migration, backup, verify
│   ├── process/        # scoped bounded process execution
│   ├── git/            # Git questions and guarded mutations
│   ├── github/         # gh-backed pull request observation
│   ├── desktop/        # i3, kitty, browser adapters
│   ├── rpc/            # Effect RPC transport adapters
│   └── systemd/        # user-service installation and compatibility
├── daemon/             # daemon Layer and entry point
├── client/             # ManagedRuntime bridges, dashboard, CLI, tools
├── topic-agent/        # scoped registration, heartbeat, reconnect
└── test-support/
```

Dependency direction:

```text
Pi / CLI / TUI / systemd / RPC adapters
                  ↓
          application modules
                  ↓
             pure domain
                  ↑
 SQLite / Git / GitHub / desktop adapters
```

Raw SQL stays inside storage. Raw process execution stays inside process infrastructure. Application modules do not import platform implementations.

## Deep module interfaces

### Topic repository

Hide:

- SQL statements
- transactions
- row decoding
- row revisions
- uniqueness
- graph persistence
- timestamps
- setup checkpoints

Expose domain operations, including atomic family updates and Topic deletion with chain repair. Do not expose generic row CRUD.

### Operation repository and engine

Hide:

- request fingerprinting
- operation claims
- checkpoints
- terminal result encoding
- retention
- confirmation persistence
- restart recovery
- supervised fibers

Expose start, get, watch, cancel request, and idempotent Atomic Command execution.

### Process executor

Hide:

- Effect child-process handles
- process groups
- Scope cleanup
- deadlines
- output Streams
- combined output limit
- environment removal

Expose one bounded semantic process result. Repository Recipe commands use a shell explicitly; argument-safe adapters do not.

### Work state

Hide mutable state and publication. Expose immutable snapshot reads and a revisioned state stream. All changes pass through one serialized reducer.

### Git modules

Expose semantic questions and commands, not arrays of Git arguments. Examples include resolving a revision, reading ancestry, inspecting a Worktree, calculating Integration Status, and guarded rebase.

## Persistence

### Files

- `~/work/config.json`: strict human-authored configuration
- `~/work/work.db`: authoritative daemon-owned state
- `~/work/backups/`: private verified backup bundles
- `$XDG_RUNTIME_DIR/pi-workd.sock`: private RPC socket
- `$XDG_RUNTIME_DIR/pi-workd.lock`: lifetime single-daemon lock

Old `topics/`, `affiliations.json`, and `migrations/` paths are migration input only. The final application does not read them.

### Configuration

Configuration is versioned and strict. Unknown fields fail validation after one migration. The daemon does not rewrite the file during a normal read.

A repository `integrationBranch` is a human override. SQLite stores an inferred Integration Branch. The override wins. Removing it exposes the inferred value. Reset deletes the inferred value and runs inference again.

### SQLite content

Use normalized tables with foreign keys and checks for:

- Topics
- setup state and checkpoints
- Topic relationships
- Main Agent durable identity
- inferred repository state
- Durable Operations and step checkpoints
- Atomic Command idempotence results
- confirmations
- Private local capability hashes
- storage metadata and migration receipts

Store bounded schema-validated JSON only for flexible operation input and result payloads.

### Invariants

SQLite enforces simple local invariants:

- primary identities
- unique `(repository, branch)`
- foreign keys
- non-self Parent and Integration Target references
- restricted deletion
- checked enum values
- unique client and request identity
- unique capability hashes

Application transactions enforce graph invariants:

- one-level Topic families
- same-repository family members
- no Integration Chain cycle or fork
- one Partition per family
- unique child Origin Commit
- valid direct Integration Targets

Every row is decoded with Effect Schema after reading. `pi-work storage verify` checks SQL and domain invariants.

### Observed state

Do not persist cache-like observations:

- Integration Status
- Git Operation State
- Worktree cleanliness
- orphan status
- live pull request details
- live Main Agent activity
- observation diagnostics
- active Ephemeral Actions

Rebuild these after daemon restart.

### Write and publication order

1. Read durable state and row revisions.
2. Perform external observations outside the SQL transaction.
3. Revalidate Git tips and expected row revisions when required.
4. Commit a short SQLite transaction.
5. Apply returned committed records to one in-memory projection reducer.
6. Increment the daemon revision.
7. publish the semantic state change.

Never publish an uncommitted durable change. Never run a child process or network call inside a SQLite transaction.

## Concurrency

Use keyed structured concurrency:

- Topic mutation key
- Topic family key
- repository mutation key
- `(repository, branch)` creation key
- global bounded process permits

Multi-key acquisition sorts and removes duplicate keys. Scope finalizers release all permits. Independent Topics and repositories remain concurrent.

For Git-derived metadata changes:

1. acquire the repository mutation key
2. resolve relevant Branch tips
3. calculate the plan
4. resolve tips again
5. reject when any tip moved
6. commit only when Topic row revisions still match

This coordinates daemon work. It cannot lock unrelated external Git processes, so commands fail closed when they detect a race.

Observation passes use bounded concurrency and never overlap with another pass of the same kind.

## Durable Operation lifecycle

Expected states include:

- accepted
- awaiting-confirmation
- running
- setup-interrupted
- succeeded
- failed
- cancelled

The exact schema must make terminal and resumable states explicit.

Creation and provisioning record:

- operation identity
- client and request identity
- input fingerprint
- Topic identity
- Recipe snapshot
- current semantic phase
- completed deterministic checkpoints
- current Setup command index
- bounded progress
- terminal result or typed failure

A client wait is not the operation. Losing the client interrupts only its wait.

### Repository Recipe rules

- An accepted attempt uses one Recipe snapshot.
- Completed commands have durable checkpoints.
- Deterministic provisioning resumes after daemon restart.
- If supervision ends while a Setup command runs, mark `setup-interrupted`.
- Never rerun or skip that uncertain command automatically.
- Explicit Retry Setup starts a new attempt from command one with the latest configuration.
- Setup commands must tolerate at-least-once execution.
- Do not emit full command text in general logs or diagnostics.

### Cancellation

**Cancel Setup** requires policy and direct confirmation. It interrupts the operation fiber, kills the process group, records `cancelled`, preserves completed checkpoints and external artifacts, and leaves the Topic recoverable through Retry Setup.

Daemon shutdown interruption is not user cancellation.

### Retention

- active operations: retain
- pending confirmations: retain until use or expiry
- terminal command results: retain 30 days
- terminal command result count: at most 10,000
- semantic results only; no raw process output

Scheduled bounded maintenance prunes old terminal data.

## Confirmation and capabilities

Durable-operation confirmations survive daemon restart. Ephemeral confirmations do not.

Persist only token hashes. A raw token is a Private local capability. It can exist in a process environment or direct client response but not in logs, spans, snapshots, ordinary errors, or normal database exports where omission is possible.

The Unix user is the security perimeter. Client IDs are for idempotence, not authorization. Any client on the private socket can inspect operations. Cancellation still needs policy and direct human confirmation.

Main Agent registration and reattachment retain current behavior with stronger storage:

- one connected Main Agent per Topic
- one-use short-lived registration capability
- window affiliation capability survives daemon restart
- reset rotates related capabilities
- durable session identity changes atomically on adoption
- live activity remains observed
- heartbeat expiry does not delete durable identity
- Delegation Jobs receive no Topic Agent capabilities

## Effect RPC

Use Effect RPC over an Effect Unix socket with bounded NDJSON serialization.

Provide:

- a minimal compatibility handshake
- application protocol version
- storage schema version
- daemon build identity
- daemon start identity
- operation start, get, watch, and cancel request calls
- Atomic Commands
- Ephemeral Actions
- snapshot-first state subscription

### State stream

The first stream item is a complete immutable snapshot with daemon identity and revision. Later items are semantic changes with increasing revisions.

Each client has a bounded outgoing queue. A slow client never blocks a state update. Overflow emits `ResyncRequired` when possible and closes the stream. A client also resubscribes when it detects a revision gap.

### Compatibility

The systemd client manager performs the compatibility handshake. It restarts an incompatible daemon and waits for a compatible one within a bounded deadline. Do not rely on a decode failure as the compatibility mechanism.

## Daemon lifecycle

Acquire the exclusive daemon lock before database migration or recovery. Keep it until shutdown. The socket alone is not the singleton guard.

Startup:

1. validate private paths and ownership
2. acquire daemon lock
3. validate configuration
4. validate SQLite and apply backed-up schema migration
5. recover Durable Operations
6. hydrate durable projection
7. become ready
8. publish observations as `refreshing` or `unknown`
9. run local observation
10. start GitHub observation

Git and GitHub do not block readiness. Any mutation that needs fresh Git state revalidates it itself.

Shutdown:

1. stop accepting work
2. publish stopping state
3. stop new schedules and reconnects
4. give short Atomic Commands bounded time to commit
5. close client waits
6. interrupt Ephemeral Actions
7. interrupt Durable Operation fibers after checkpoints
8. terminate and await owned process groups
9. close sockets and SQLite scope
10. release the daemon lock

Shutdown has a fixed deadline. It never waits indefinitely for a Setup command.

## Observation

- local health: 30 seconds after the previous pass completes
- pull requests: 60 seconds after the previous pass completes
- explicit refresh joins a current single-flight pass
- lease and confirmation expiry sleep until the next known deadline
- GitHub retries use bounded exponential delay with jitter
- all schedules use Effect time and have `TestClock` coverage

Keep `git`, `gh`, `wt`, `i3-msg`, kitty, and `xdg-open`. All run through the scoped process module.

## Error policy

**Expected failures** use tagged errors or explicit domain outcomes and cross RPC as bounded schemas.

**Operational failures** retain a safe public message and internal cause. Log them with operation and Topic annotations.

**Defects** remain defects. Return a generic correlated internal error to the client and log the full Cause. A request defect does not stop unrelated RPC streams. A startup integrity or migration defect prevents readiness.

Never log raw capabilities, credentials, Setup commands, unrestricted process output, or session content.

## Backups and recovery

Before the first JSON import and every SQLite schema migration:

1. create a consistent SQLite export when a database exists
2. copy strict configuration
3. include migration metadata and checksums
4. write a private backup bundle
5. fsync the files and containing directory
6. verify the bundle before mutation

Also create one daily backup after durable state changed. Retain the latest 14 daily backups. Never automatically delete the original JSON migration backup. Backup bundles contain hashes or redacted records for Private local capabilities, not raw bearer values.

Automatic restore is forbidden. A failed migration preserves evidence and gives exact verify and restore commands. Restore requires a stopped daemon and an explicit backup path.

## Existing-data migration

The migration uses explicit preparation, import, cutover, verification, and removal stages.

### Automated preparation

A temporary `pi-work storage migrate` implementation:

- verifies the daemon is stopped
- verifies old storage ownership and permissions
- settles or rejects incomplete old migration journals
- rejects unresolved Legacy name hierarchies
- validates every Topic and affiliation record
- creates a timestamped private backup of durable source data, with raw capabilities replaced by hashes or redacted records
- builds a temporary SQLite database
- imports all current durable fields
- hashes imported capabilities
- verifies counts, identities, relationships, Partitions, setup checkpoints, Notes, Main Agent references, and Pull Request identities
- atomically installs the database
- writes a migration receipt

Any invalid or ambiguous Topic blocks the full migration. It never skips or guesses.

### Import checkpoint

The human:

- resolves any reported old hierarchy before retrying
- runs the migration with explicit access to live `~/work`
- verifies the installed database, backup, source comparison, and receipt
- records approval for production cutover in the migration issue

### Production cutover

After import approval, an agent switches all production entry points to the new daemon, client, dashboard, tools, CLI, and Topic Agent adapters. Old code remains unreachable but present for one short diagnostic window.

### Post-cutover checkpoint

The human starts the new daemon, verifies the real dashboard and representative actions, restarts the daemon, verifies resubscription and Main Agent reattachment, and records explicit approval for removal.

### Final removal

Only after post-cutover approval:

- remove old Topic JSON stores
- remove old affiliation stores and raw affiliation files after approval
- remove old migration journal code
- remove Legacy name hierarchy planning and UI
- remove the temporary importer and migration command
- remove custom protocol and client code
- remove Promise lifecycle code and obsolete tests

The backup remains. The final application ignores old live JSON paths.

## Dashboard and clients

The dashboard reducer and rendering remain pure. A per-view `ManagedRuntime` owns:

- RPC connection
- snapshot stream
- reconnect schedule
- mutation fibers
- operation watches
- shimmer schedule

Disposal closes the runtime. There are no manually cleared dashboard lifecycle timers.

Pi tool and CLI adapters resolve local Start Points before they start the Durable Operation. They wait by Operation Handle and can stop waiting without cancellation.

The Topic Agent creates its runtime only in a valid Topic session. It uses one scoped reconnect schedule and reasserts effective activity after registration.

The auto-discovered extension entry must not construct or eagerly import the full runtime in an ordinary Pi session.

## Architecture enforcement

Automated checks enforce capabilities and dependency direction:

- domain imports no application, infrastructure, Pi, TUI, Node, Bun, or Effect runtime modules
- application imports domain and module interfaces, not live adapters
- raw SQL exists only in storage
- direct process APIs exist only in the process adapter
- direct socket APIs exist only in an approved custom adapter, if needed
- direct timers exist only in documented external callback adapters
- root `effect` barrel imports are rejected in Work production code
- long-lived fibers use approved scoped supervisors
- adapter exceptions are explicit and small

Lifecycle integration tests, not syntax checks alone, prove cleanup.

## Test strategy

Use Bun test at four levels.

### Pure tests

Test planning, validation, state reduction, rendering, and schema transformations without a runtime.

### Layer tests

Use test Layers and `TestClock` for operations, locking, state streams, retry, expiry, cancellation, and leases.

### Real integration tests

Use temporary resources for:

- SQLite migrations and transaction rollback
- real Git repositories
- real Effect RPC Unix sockets
- real process groups and forced interruption
- daemon restart recovery
- backup verification

### Live verification

Use the human migration checkpoint for real `~/work` data.

Replace shallow implementation tests with tests at deep module interfaces. Do not keep duplicate tests for deleted implementations.

## Performance and resource acceptance

Capture a pre-migration baseline and compare at final acceptance.

Required properties:

- ordinary Pi startup does not construct the Work runtime
- an ordinary non-Topic session does not construct the Topic Agent runtime
- daemon startup stays within the current bounded connection workflow
- dashboard open and reconnect have no material regression
- idle polling never overlaps
- an idle dashboard has no render loop
- every queue and output capture is bounded
- SQLite transactions contain no child process or network wait
- one slow client cannot block mutations
- shutdown leaves no owned socket, child process, timer, or fiber

Any material regression needs a measured explanation in the final issue.

## Issue sequence

The implementation issues are in `issues/`. Their numbers are a topological delivery order:

1. Effect foundation and contract probes
2. domain schemas and typed failures
3. strict configuration
4. SQLite Topic storage
5. operation and capability storage
6. backup and verification
7. scoped process execution
8. Git adapters
9. GitHub and desktop adapters
10. keyed concurrency
11. state projection and subscriptions
12. operation engine
13. durable provisioning
14. Topic and Integration Chain commands
15. rebase and observation workers
16. Main Agent lifecycle
17. Effect RPC server
18. client runtime and systemd compatibility
19. dashboard runtime
20. tools, CLI, and Topic Agent integration
21. JSON-to-SQLite migration tool
22. Effect RC upgrade check
23. human live-data import and verification
24. production cutover
25. human live cutover verification
26. legacy implementation removal
27. final hardening, performance, and documentation

Issue 24 is blocked until issue 23 records import approval. Issue 26 is blocked until issue 25 records post-cutover approval. Later issue statuses must be promoted only when their dependency is complete.

## Completion

The epic is complete only when:

- the human-approved SQLite migration preserves existing Topics
- all production Work entry points use the Effect implementation
- all current non-Legacy features pass interface and integration tests
- Legacy name hierarchy behavior is absent
- old storage and protocol code is absent
- strict architecture checks pass
- `bun run check` passes
- daemon restart, cancellation, process cleanup, RPC resync, migration failure, and backup restore tests pass
- performance comparison is recorded
- README and operational recovery guidance describe only the final system
