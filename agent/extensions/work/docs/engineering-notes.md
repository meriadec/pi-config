# Work engineering notes

## Effect v4 foundation

Work pins `effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` to the same exact
`4.0.0-rc.115` release candidate.

### Release candidate review

Reviewed on 2026-09-15. The npm `rc` distribution tag for `effect`,
`@effect/platform-bun`, and `@effect/sql-sqlite-bun` was `4.0.0-rc.115` for all three
packages. This is the same release as the existing pin, so there are no intervening
release notes or breaking API changes to apply. The installed package AI docs, package
metadata, and declarations for the Work APIs remain consistent with the contract tests.

The decision is to keep all three exact `4.0.0-rc.115` pins. The root `package.json`
records the selected family, and `bun.lock` records each resolved version and integrity
hash. The full foundation contracts passed again, including `ManagedRuntime` disposal,
`TestClock`, Unix RPC, SQLite transactions, and process-group cleanup.

### Import convention

Work code must import the smallest direct Effect module. For example, use
`effect/Effect`, `effect/Layer`, and `effect/unstable/rpc/Rpc`; do not import the root
`effect` barrel. The same convention applies to Bun and SQLite platform modules. This
keeps the import graph explicit and reduces startup cost. The root barrel is permitted
only in the startup benchmark itself, not in Work production code.

### Contract results

The permanent Bun contracts are in `agent/extensions/work/foundation.contract.test.ts`.
They prove:

- lazy, single construction and scoped disposal of a `ManagedRuntime`;
- deterministic sleep control with `TestClock`;
- an Effect RPC request and response over a real temporary Unix socket, using NDJSON
  with a 1,024-byte parser buffer limit;
- SQLite migration, transaction commit and rollback, foreign-key enforcement, and
  scoped close;
- scoped interruption of a child process and its descendant process group;
- combined stdout and stderr capture with a strict byte limit.

All selected upstream adapters passed these contracts. No custom adapter is necessary.
The tests use temporary paths, readiness output instead of fixed sleeps, and scoped
cleanup for sockets, databases, and processes.

### Import startup baseline

Measured on 2026-09-15 with Bun 1.3.14, Linux 7.0.0-31-generic x86_64, and an AMD
Ryzen AI 9 HX PRO 370. Each sample started a new Bun process and imported one module.
One warm-up was discarded, then 30 alternating samples were measured around the full
child-process lifetime.

| Import               |   Median |     Mean |  Minimum |   Maximum |
| -------------------- | -------: | -------: | -------: | --------: |
| `effect/Effect`      | 41.22 ms | 40.38 ms | 26.73 ms |  48.57 ms |
| `effect` root barrel | 88.17 ms | 87.70 ms | 62.03 ms | 110.67 ms |

The direct import median was 46.95 ms lower for this baseline. These values are a local
comparison, not a cross-machine performance target.

## Final hardening and acceptance

Final acceptance was measured on the same host and Bun version on 2026-09-15. The
historical comparison uses commit `961d755`, the last production commit before the Effect
migration plan. Each import measurement started a new Bun process. One warm-up was
discarded, and the next 10 samples were measured with GNU `time`. Times have 10 ms
resolution, so they show material differences and not small differences.

| Cold import proxy                  | Historical median | Final median | Historical peak RSS | Final peak RSS |
| ---------------------------------- | ----------------: | -----------: | ------------------: | -------------: |
| Pi auto-discovered `work/index.ts` |             60 ms |        40 ms |          78,872 KiB |     62,612 KiB |
| Dashboard module                   |             40 ms |       110 ms |          59,988 KiB |     98,264 KiB |
| Daemon application module          |             20 ms |        80 ms |          43,740 KiB |     89,944 KiB |

The final Pi entry initially measured 140 ms and 116,228 KiB. This was a material
regression. The entry exported and imported the complete client runtime. Final hardening
removed the runtime re-exports and moved client, dashboard, planning, and Topic Agent
runtime imports to the command or valid-session boundary. The final entry is now faster
and smaller than the historical entry, and an ordinary Pi session constructs no Work
runtime.

The dashboard and daemon import proxies are 70 ms and 60 ms slower. Their peak RSS is
38,276 KiB and 46,204 KiB higher. These differences are accepted. The final modules load
the Effect RPC, scoped runtime, and SQLite control-plane code that replaces manual
Promise, socket, timer, and JSON lifecycle code. The dashboard is loaded only when the
human opens `/work`. The daemon is a persistent systemd service, and its compatibility
startup path has a bounded deadline. Real Unix-socket tests cover startup, connection,
reconnection, shutdown, and disposal.

Five final daemon samples measured memory after readiness and again after one idle second.
Mean RSS decreased from 96,701 KiB to 95,512 KiB, a mean change of -1,189 KiB. This is
not evidence of unbounded long-term growth, but it confirms that one idle observation
interval does not start an allocation or render loop. TestClock tests also prove that
local polls start after the prior pass, concurrent refreshes join one pass, retries are
bounded, Main Agent leases expire, confirmations expire, and operation retention runs on
Effect time. The dashboard disposal test proves that its shimmer, watches, queue, and
runtime stop together.

### Robustness and security evidence

The final `bun run check` executes 210 tests. The acceptance coverage includes:

- daemon singleton ownership, ordered bounded shutdown, socket removal, dashboard
  disposal, Topic Agent schedule disposal, operation restart, state overflow, revision-gap
  resubscription, and descendant process termination;
- SQLite commit and rollback, migration failure, per-checkpoint transaction injection,
  backup preparation injection, verified restore rollback, operation checkpoint recovery,
  and atomic post-commit state publication;
- real Git tip movement, successful and interrupted rebases, conflicted-operation
  observation, and Worktree validation;
- TestClock control of polls, retry, heartbeat and registration leases, confirmation
  expiry, and terminal-result retention;
- architecture checks for dependency direction, direct Effect imports, SQL ownership,
  process and socket ownership, documented callback-timer exceptions, deleted paths, and
  lazy runtime loading.

The final security audit found no raw capability in public domain encoding, SQLite
capability rows, or verified backup records. Storage keeps hashes. Desktop startup keeps
capabilities only in the child environment. GitHub credentials pass through the systemd
user-manager environment and do not enter generated unit text or command arguments.
Main Agent code does not read Pi session content. Setup command output is drained through
one bounded process result, and general diagnostics use bounded public failures instead
of command text or unrestricted output. The original private migration backup remains
unchanged and outside retention pruning.
