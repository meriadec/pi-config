# Epic — Deepen the Work control plane

Status: ready-for-agent
Type: epic
Affected extension: `work`

## Problem

The `work` extension has a sound runtime split, but the Unix-socket seam is not an independent module. Client code imports types from daemon implementations, protocol data imports Topic Service and Main Agent types, and each Action is repeated across protocol unions, parsers, client methods, dashboard interfaces, server dispatch, and Topic Service methods.

Topic creation also repeats one application workflow in the CLI and Pi tool. The dashboard exports much of its implementation as interface. `TopicService` concentrates valuable behavior, but it also owns request coordination, confirmation continuations, pull request polling, Topic mutations, and desktop orchestration in one implementation.

This structure reduces locality. A control-plane change spreads across callers and adapters, and successful socket responses cross the process seam through unchecked TypeScript casts.

## Outcome

- One control-plane contract module owns every wire command, result, event, snapshot, error, and codec.
- Client and daemon adapters depend on that contract and do not import each other's implementations.
- The control-plane interface has a small command, subscription, and lifecycle surface.
- Both socket directions validate untrusted data before it enters an implementation.
- Topic creation resolution, connection, confirmation, cancellation, progress, and cleanup live behind one application interface used by the CLI and Pi tool adapters.
- The dashboard presents a small model interface; wizard, sorting, layout, rendering, and shimmer details stay inside its implementation.
- Topic Service keeps durable Topic behavior while internal modules own request coordination, Action confirmation, and pull request projection.
- Domain, persistence, and platform imports show dependency direction without a broad `shared` drawer.

## Architecture principles

- The Unix socket is a remote-but-owned seam. Its contract is independent of both transport adapters.
- A wire command is domain data. Socket request IDs, client IDs, NDJSON frames, and timeouts are transport data.
- The control-plane contract contains data and validation only. It does not import client, daemon, TUI, systemd, persistence, or external-command implementations.
- The daemon remains the only owner of Topic manifests, provisioning, Action policies, deduplication, concurrency, Main Agent leases, and live observations.
- Internal seams support the control-plane implementation. They do not enlarge the external interface.
- Tests use the same interface as callers. When a deep module replaces shallow modules, replace implementation-level tests with interface-level behavior tests.
- Preserve current protocol behavior unless an issue explicitly requires a version change.

## Dependency direction

```text
Pi / CLI / TUI / Topic Agent adapters
                 |
        control-plane contract
                 |
       control-plane implementation
                 |
       domain + internal ports
                 |
 persistence / process / desktop / GitHub adapters
```

The control-plane client and daemon socket server are adapters at the same seam. Neither adapter owns the seam.

## Invariants

- Existing Topic manifests and configuration files remain compatible.
- Existing Topics, Worktrees, Branches, Main Agent sessions, and affiliations survive the refactor.
- Request deduplication keeps the same client-ID and request-ID semantics across reconnects.
- An Action policy decision remains authoritative in the daemon.
- `ask` still requires direct human approval and has no approval field on the original request.
- Start Point and Source checkout remain creation input and never enter the Topic manifest.
- Protocol frames, process output, errors, and progress stay bounded.
- The daemon and clients can still reject an unsupported protocol version clearly.

## Non-goals

- Do not add new user-visible Work features.
- Do not change Topic identity or manifest format.
- Do not replace the Unix socket, systemd, i3, kitty, `gh`, `wt`, or Pi.
- Do not create one class per Action or split Topic Service into shallow pass-through modules.
- Do not expose internal coordination, confirmation, or projection seams to presentation adapters.
- Do not preserve old helper exports only for tests when the helper is no longer part of the intended interface.

## Validation

- Contract tests cover every command, result, event, snapshot, and error variant in both directions.
- Integration tests run dashboard, CLI, Pi tool, and Topic Agent calls through the real socket adapter.
- Existing recovery, confirmation, deduplication, reconnect, and bounded-output behavior remains covered.
- Import-direction checks prevent client-to-daemon and daemon-to-client implementation imports.
- `bun run check` passes after every issue.

## Issue order

1. `01-extract-the-control-plane-contract.md`
2. `02-validate-both-sides-of-the-wire.md`
3. `03-deepen-command-execution.md`
4. `04-unify-topic-creation-orchestration.md`
5. `05-narrow-the-dashboard-interface.md`
6. `06-extract-request-coordination.md`
7. `07-extract-action-confirmation.md`
8. `08-isolate-pull-request-projection.md`
9. `09-finish-module-direction-and-validation.md`

Issues 01 through 03 establish the external seam. Issues 04, 05, and 08 can then proceed in parallel. Issue 06 precedes issue 07 because confirmation continuations use request identity and Topic serialization. Issue 09 is the final consolidation and architecture gate.

## Comments
