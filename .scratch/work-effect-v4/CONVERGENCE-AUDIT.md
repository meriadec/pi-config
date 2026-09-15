# Work Effect migration convergence audit

Date: 2026-09-15

## Comparison point

- Previous production implementation: `33500e4` (`origin/main` before the Effect migration)
- Current implementation: `e239efc`
- Migration specification: `.scratch/work-effect-v4/PRD.md`

The PRD says to preserve the dashboard experience, keys, layout behavior, actions, status meanings,
Topic Agent environment meanings, tools, CLI commands, policy semantics, creation, child creation,
Partitions, Notes, Main Agent control, pull request observation, Integration Status, chain maintenance,
guarded rebase, Worktree recovery, and Repository Recipes. It permits removal of Legacy name hierarchy
behavior only. It also adds Cancel Setup and Reset Integration Branch to the dashboard.

## Status terms

- **Present**: the current production path provides the previous user-visible behavior.
- **Partial**: part of the behavior exists, but an important path, guard, detail, or test is absent.
- **Missing**: no current production path exposes the behavior.
- **Broken**: code exists, but current wiring or semantics contradict the previous behavior.
- **Intentional removal**: the PRD explicitly permits removal.
- **Added**: a new Effect migration requirement that is available.

## Executive result

The daemon rewrite retained much of the low-level domain and infrastructure capability. The main
convergence failure is at product composition boundaries. The current dashboard exposes only 10 of
the previous 17 Topic action-rail actions, omits both creation wizards, omits 3 direct keys, weakens
availability and policy behavior, and does not render several state fields that the new runtime already
calculates. Some backend facts were also narrowed before projection, so the old UI cannot be restored
from the current snapshot without schema changes.

The Topic Agent has an expected lease-loss recovery defect: it logs a failed heartbeat as a failed
re-attachment and waits for the next five-second cycle before it tries to register or adopt again.

Across the 96 catalog rows, 19 are Present, 39 Partial, 16 Missing, 19 Broken, 1 an intentional
removal, and 2 Added. Thus, only 19 of 93 retained previous behaviors are currently confirmed as
present at their product boundary. A Partial mark can include working backend code, but it does not
claim user-visible convergence.

Test names are not a direct quality metric, but the removed behavior matrix is much larger than its
replacement:

| Surface | Previous tests | Current direct tests |
| --- | ---: | ---: |
| Dashboard renderer, reducer, component | 82 | 13 |
| Topic Agent reporter | 13 | 2 |
| CLI parser and outcomes | 11 | 0 |
| Root Topic tool | 13 | 0 |
| Child Topic tool | 7 | 0 |
| All Work tests | 423 | 173 |

The current Operation Adapter has 3 tests and covers a shared part of tool and CLI waiting. It does
not cover their public schemas, parsing, output, confirmation, or error contracts.

## 1. `/work` command and dashboard startup

| ID | Previous behavior | Current status | Evidence and discrepancy |
| --- | --- | --- | --- |
| CMD-01 | `/work` registers once and refuses non-TUI use. | Partial | `effect-command.ts` keeps the TUI guard, but the old command test was removed and no current command test replaces it. |
| CMD-02 | First `/work` asks for `WORK_BASE`, validates an absolute writable directory, preserves policy config, and writes nothing on cancel. | Missing | Old `setup.ts` and four setup tests were deleted. `effect-command.ts` reads paths and connects directly. Strict config now fails when configuration is absent. |
| CMD-03 | Opening the dashboard starts or connects to `pi-workd`. | Present | `effect-command.ts` uses `SystemdWorkdManager` and the Effect runtime. |
| CMD-04 | Protocol mismatch restarts a stale daemon. | Present | Current systemd tests cover explicit incompatible-daemon restart. |
| CMD-05 | Closing the dashboard does not stop the daemon or Main Agent and releases dashboard resources. | Present | Component disposal closes only its client runtime; dashboard runtime tests cover disposal. |
| CMD-06 | Loading, empty, connected, reconnecting, and failure states are visible. | Partial | Initial loading, empty, and failure text exist. When a stream fails after a snapshot, `phaseMessage` is ignored by `renderDashboardView`, so stale data stays visible without the reconnect message. |
| CMD-07 | Diagnostics are visible and bounded. | Missing | Diagnostics are projected in `WorkSnapshot` but `dashboard-view.ts` does not render them. |

## 2. Dashboard keys and focus behavior

| ID | Key or navigation | Current status | Discrepancy |
| --- | --- | --- | --- |
| KEY-01 | `a` or `A`: open root Topic wizard. | Missing | There is no wizard state or create action in the current dashboard. |
| KEY-02 | `r`: refresh local state, then start pull request refresh. | Partial | `r` calls aggregate `refresh`, but old progress and local/background distinction are not shown. |
| KEY-03 | `n`: edit Note from list only when Topic is not busy. | Partial | Note editing exists, but the shortcut also fires while details/actions have focus. |
| KEY-04 | `Shift+J` / `Shift+K`: move the selected family only from list focus. | Partial | Movement exists and is serialized, but it fires from every focus. Failure does not stop the remaining queue as before. |
| KEY-05 | `m`: open/focus Main Agent only when available and list-focused. | Partial | The key exists, but it ignores focus and availability. Policy is not enforced. |
| KEY-06 | `o`: open/focus Topic workspace only when available and list-focused. | Partial | The key exists, but it ignores focus and availability. Current action-rail availability is also stricter than before. |
| KEY-07 | `p`: open the pull request in a browser. | Missing | Browser action exists in the rail, but the direct key is absent. |
| KEY-08 | `t`: open a new terminal. | Missing | Terminal action exists in the rail and daemon, but the direct key is absent. |
| KEY-09 | `s`: guarded rebase, or show the exact unavailable reason without invocation. | Partial | The key always emits Rebase when a Topic exists. The daemon retains important guards, but the UI does not show the old reason before invocation. |
| KEY-10 | `j` / `k` and arrows move list selection or action focus. | Partial | Basic movement exists. Action movement now wraps and skips unavailable actions; the old rail let focus land on an unavailable action and explained it on invocation. |
| KEY-11 | `l`, right, or Enter opens the action rail on its first available action. | Present | Restored in `e239efc`. |
| KEY-12 | `h` / left moves actions → detail → list while the sidebar stays open. | Broken | Current detail → left closes the sidebar, so the old three-focus navigation is absent. |
| KEY-13 | `q` or `Q` closes details; Escape exits the dashboard. | Broken | Uppercase `Q` is absent. Current Escape closes an open sidebar instead of exiting. Lowercase `q` closes the sidebar, then exits on a second press. |
| KEY-14 | Direct shortcuts do not run while the selected Topic has an action in flight. | Partial | Component execution blocks the same Topic, but the pure input model still emits actions and gives no old unavailable feedback. |
| KEY-15 | Editors use standard text input, cursor movement, and bracketed paste. | Broken | The new editor appends printable data and handles backspace only. Cursor editing and the old `Input` behavior are absent. |

## 3. Root and child Topic creation in the dashboard

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| CRT-01 | Root wizard asks for name, repository, generated/editable Branch, and review. | Missing | No dashboard creation state or action exists. |
| CRT-02 | Known repositories are fuzzy filtered; arrows highlight; Tab completes; Enter uses typed text. | Missing | The entire completion model and UI were deleted. |
| CRT-03 | Wizard validates empty names, repository syntax, and Git-safe Branches before submission. | Missing | Tool/CLI planners validate these values, but there is no dashboard wizard. |
| CRT-04 | Escape cancels every wizard stage without submission. | Missing | No dashboard wizard exists. |
| CRT-05 | Added Topic becomes selected and duplicate Create is blocked. | Missing | No dashboard create path exists. |
| CRT-06 | Create keeps one request identity across transport retry. | Partial | Durable operation requests have identities in tool/CLI planning. No dashboard create request exists. |
| CRT-07 | Parent Topic rail offers Add Child Topic only on a root. | Missing | Backend child provisioning exists; the dashboard action and wizard do not. |
| CRT-08 | Child wizard asks for name, Parent Branch Start Point, and optional Branch. | Missing | Tool/CLI support exists; dashboard support does not. |
| CRT-09 | Creation policy `ask` uses an exact direct human dialog; deny and reject remain distinct. | Partial | Operation Adapter can show a generic Pi confirmation for tool calls. Dashboard creation is absent. Exact action text and old result distinctions are not preserved at the dashboard boundary. |

## 4. Topic list rendering, ordering, and scrolling

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| LST-01 | Full terminal height and helper row at the bottom. | Present | Restored in `2e762cc` and `e239efc`. |
| LST-02 | Previous wide column order, natural widths, Note spare width, settled blank cells, and Nord selection highlight. | Present | Restored in the two dashboard follow-up commits. |
| LST-03 | Narrow layout stays within width and adds only non-empty status segments. | Present | Current compact rows now omit empty segments; width truncation remains. |
| LST-04 | Partition is the primary order and blank rows separate Partitions. | Present | Current sort and renderer preserve Partition order and separators. |
| LST-05 | Active Main Agent families bubble above inactive peers inside a Partition. | Missing | `orderedTopics` sorts roots by name only. |
| LST-06 | Durable children render in Integration Chain order; pending children keep intended position. | Broken | `orderedTopics` sorts children by name. The existing `displayChildOrder` domain helper is not used by the dashboard. |
| LST-07 | Selection remains visible in a bounded window for large Topic sets. | Missing | Current rendering always starts at the first Topic and stops at terminal capacity. A selected Topic below the window is invisible. |
| LST-08 | Selection stays by Topic ID across updates and sorting. | Present | `reconcileDashboardSelection` preserves an existing selected ID. |
| LST-09 | Deleting the selected Topic chooses the nearest remaining row. | Broken | Reconciliation chooses the first Topic after the selected ID disappears. |
| LST-10 | Orphan Topic is bright red and Setup says `orphan`. | Partial | The row can become bright red, but Setup does not show `orphan`. |
| LST-11 | Stopped rebase/merge/cherry-pick/revert appears in bright red with pending/conflict detail. | Broken | Projection narrows Git operation state to only the operation kind. Conflict/pending detail is discarded and the Setup cell does not render it. |
| LST-12 | Active statuses shimmer with separate Thinking and Tracking PR palettes and `thinking (sub)` text. | Broken | Runtime advances `effectState.shimmerPhase`, but rendering reads the independent `viewState.shimmerPhase`, which is never synchronized. The current palette and label rendering are also simplified. |
| LST-13 | Inactive Topic rows are dim; selected inactive rows keep dim text under the background highlight. | Broken | Current renderer dims only the unselected branch. A selected inactive row receives the background highlight without the old dim text composition. |
| LST-14 | Reconnect state keeps Topics visible and shows reconnect status. | Broken | Snapshot remains, but reconnect text is not rendered when a snapshot exists. |

## 5. Pull request presentation

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| PR-01 | List shows linked `#<number>` and progressive status. | Broken | Current list shows only a colored dot for open PRs or the terminal state word. Number and hyperlink are absent. |
| PR-02 | Status precedence includes merged, closed, draft, CI failing, feedback, checks, approved, ready, reviewing, and clear. | Partial | The current observation contains most source facts, but the dashboard reduces them to state and CI only. |
| PR-03 | PR action appears only when a PR exists and opens the browser. | Partial | Browser opening exists, but the current rail always includes a disabled action when no PR exists instead of omitting it. |
| PR-04 | Direct `p` key opens the PR. | Missing | See KEY-07. |
| PR-05 | Durable PR identity preserves merged/closed state across restart. | Present | `DurableTopic.pullRequest` and the GitHub observer retain identity behavior. |
| PR-06 | Explicit refresh returns local results while one single-flight PR refresh continues. | Partial | Observation workers retain separate refresh operations and single flight. Dashboard feedback no longer shows this sequence. |

## 6. Detail sidebar and action rail

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| SID-01 | Wide sidebar and divider fill terminal height and open focused on Actions. | Present | Restored in `e239efc`. |
| SID-02 | Narrow terminals switch to a full-width detail view. | Partial | The switch exists, but the threshold and wide split differ (`72` and 46% versus old `96` and 34%). |
| SID-03 | Three focus states are visible: list, detail, actions. | Partial | State type remains, but left-navigation and headings do not preserve the old focus experience. |
| SID-04 | Details show name, Note, Branch, repository, Base checkout, Worktree, Setup/operation, Git operation, Integration details, Main Agent, workspace, PR, and diagnostic. | Partial | Current details omit Base checkout, workspace number, operation detail, observation freshness, and diagnostics. |
| SID-05 | Integration detail shows exact target, Integration Branch, ahead/behind counts, pending state, and bounded diagnostic. | Broken | Git calculates counts, but observation projection discards them. Integration Branch source helpers exist but are not wired to the view. Root target is shown only as `Integration Branch`, not the exact Branch. |
| SID-06 | Notes are yellow and move from list to details while the sidebar is open. | Partial | List Note hiding exists. Detail Note is not yellow and absent Note is rendered as an em dash. |
| SID-07 | Setup Interrupted and observation freshness are clear. | Broken | `interruptedSetupLabel` and `observationFreshnessLabel` exist only in runtime tests and have no production view caller. |
| SID-08 | Active operation detail and per-Topic submission status are visible. | Broken | Runtime watches operations and stores `operationUpdates`, but the view/component never reads that map. |

## 7. Action rail catalog

| Previous action | Current status | Notes |
| --- | --- | --- |
| Copy Branch Name | Present | First action; clipboard execution exists. |
| Access Topic Workspace | Partial | Renamed to Open Topic Workspace and incorrectly requires Setup `ready`; old rail delegated more availability to workspace selection and policy. |
| Open Terminal | Partial | Rail and daemon path exist. Direct `t` and policy enforcement are missing. |
| Open Main Agent | Partial | Rail and daemon path exist. Availability and policy parity are missing. |
| Start New Main Agent | Partial | Rail exists with a local confirmation. Policy enforcement and exact old lifecycle coverage are missing. |
| Rebase onto Integration Target | Partial | Backend is guarded. UI availability checks only `behind` and omits open PR, Worktree cleanliness, Branch checkout, Git operation, orphan, target operation, and active Main Agent reasons. |
| Open Pull Request in Browser | Partial | Execution exists, but label/presentation and direct `p` differ. |
| Rename Topic | Partial | Mutation exists; standard text input behavior is missing. |
| Add/Edit Note | Partial | Mutation exists; cursor input, exact validation text, and detail color parity are missing. |
| Retry Setup | Missing | Provisioning supports attempt `retry`, but no dashboard action or client retry planner exposes it. |
| Add Child Topic | Missing | Backend and tool/CLI support exist; dashboard action and wizard are absent. |
| Change Parent Topic | Missing | Atomic command and backend planning exist. No rail action or chooser exists. |
| Remove Parent Topic | Missing | Atomic command exists. No rail action exists. |
| Move in Integration Chain | Missing | Atomic command exists. No chooser or broken-edge confirmation flow exists. |
| Reset Integration Target | Missing | Atomic command exists. No rail action exists. |
| Migrate Legacy Name Hierarchies | Intentional removal | PRD permits removal after migration. |
| Delete Topic | Partial | Chain-safe deletion and warning exist. Policy enforcement and old availability feedback do not. |
| Cancel Setup | Broken | New runtime methods and tests exist, but no dashboard action invokes them. |
| Reset Integration Branch | Broken | New runtime method and backend command exist, but no dashboard action invokes them. |

## 8. Policy and confirmation semantics

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| POL-01 | `allow`, `ask`, and `deny` apply to clone, Worktree creation, Recipe, terminal, Main Agent open/reset, and delete. | Broken | Provisioning snapshots and enforces policy. Current terminal, Main Agent open/reset, and delete production paths do not resolve or enforce policy. |
| POL-02 | Dashboard marks denied actions unavailable. | Missing | Snapshot has no denied-action projection and current rail has no policy input. |
| POL-03 | `ask` shows exact action text and only direct approval confirms. | Broken | Dashboard reset/delete use local confirmations regardless of configured policy. Terminal and Main Agent actions bypass policy. |
| POL-04 | Confirmation-required, denied, rejected, failed, timeout, and cancelled remain distinct results. | Partial | Durable operations distinguish several states. Dashboard ephemeral and atomic action feedback collapses results to generic messages. |
| POL-05 | Sensitive action retry keeps one stable request ID. | Partial | Atomic commands do. Ephemeral desktop actions have no request identity and no old reconnect retry path. |

This is a high-severity convergence area because it changes authorization behavior, not only UI.

## 9. Integration Chain, Partitions, rebase, and Worktree recovery

| ID | Capability | Current status | Notes |
| --- | --- | --- | --- |
| DOM-01 | Partition family planning and atomic family movement. | Present | Shared planning and SQLite transaction tests exist. Dashboard failure/optimistic behavior is partial. |
| DOM-02 | Change Parent, Remove Parent, Move in Chain, Reset Integration Target. | Partial | Atomic command protocol and planning exist, but the dashboard does not expose them. |
| DOM-03 | Pending child activation after provisioning. | Present | Provisioning and Integration Chain modules retain pending/active semantics. |
| DOM-04 | Chain-safe child deletion and Parent deletion refusal. | Present | Repository and command tests cover chain repair. |
| DOM-05 | Integration Status Current/Behind/Conflict/Unknown. | Partial | Classification is present. Counts, exact target, and diagnostics are discarded before projection. |
| DOM-06 | Guarded plain rebase with volatile checks. | Partial | Observation worker and Git adapter re-read guards. UI reasons and state display are reduced. |
| DOM-07 | Worktree presence, cleanliness, orphan state, and Git operation observation. | Partial | Facts are observed. Conflict/pending detail and full UI presentation are missing. |
| DOM-08 | Integration Branch configured/inferred source and reset. | Partial | Repository state and reset command exist. Production dashboard does not show or invoke them. |
| DOM-09 | Legacy name hierarchy display and migration UI. | Intentional removal | Explicit PRD exception. |

## 10. Topic Agent and Main Agent lifecycle

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| AGT-01 | Ordinary sessions are lazy; Delegation Jobs receive no Topic Agent identity. | Present | Current environment adapter and reporter test this. |
| AGT-02 | Complete `PI_WORK_*` environment is required. | Partial | Parser keeps the meanings, but only the Delegation Job path has a direct current reporter test. |
| AGT-03 | Original session registers; in-window `/new` adopts through affiliation; mismatched sessions without affiliation are ignored. | Partial | Code paths exist. The old focused tests were removed. |
| AGT-04 | Adopted session restores `Work: <topic>` name. | Partial | Code exists; no current test covers it. |
| AGT-05 | Thinking, Delegation Job, Tracking PR, waiting, and stopped precedence. | Partial | State logic exists; old precedence and settle tests were removed. |
| AGT-06 | Heartbeat loss reconnects and reasserts effective activity. | Broken | A missing daemon lease is logged immediately as `re-attach failed`; adoption waits until the next five-second cycle. Recovery should happen in the same cycle and log only if re-attachment fails. |
| AGT-07 | Daemon restart restores durable identity and permits live re-attachment. | Partial | Backend affiliation capabilities and disconnected startup leases exist. The noisy/delayed reporter behavior breaks the user experience. |
| AGT-08 | Session shutdown reports stopped and disposes schedule/runtime. | Present | Current reporter implements it; only broad schedule disposal is tested. |
| AGT-09 | Main Agent open/focus and reset preserve prior session file and rotate capabilities safely. | Partial | Lifecycle tests cover rotation and adoption. Dashboard policy and detailed action tests are absent. |

## 11. Pi tools

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| TOL-01 | Stable tool names and core parameter sets. | Present | Both tools and expected fields exist. |
| TOL-02 | Root defaults to current checkout, resolves Start Point, infers repository, and preserves explicit Branch/repository. | Partial | Planner implements it; only one planner test exists. |
| TOL-03 | Child defaults Parent from Topic Agent environment and validates Parent Branch ancestry. | Partial | Planner implements it; no current public tool test exists. |
| TOL-04 | Exact direct policy dialog and headless confirmation-required behavior. | Partial | Shared adapter prompts with generic text when UI exists and returns awaiting state headlessly. Exact daemon action text is absent. |
| TOL-05 | Cancellation stops only waiting; daemon work continues. | Present | Operation Adapter tests cover it. |
| TOL-06 | Timeout has a distinct semantic result. | Present | Operation Adapter distinguishes timeout. Tool-level output contract is untested. |
| TOL-07 | Bounded semantic progress and bounded errors. | Partial | Progress is semantic, but previous error matrices and output bounds have no current tool tests. |
| TOL-08 | Tool result includes stable, useful Topic details. | Partial | Current result includes operation, Topic, repository, and Branch. Previous detailed result contract was replaced without direct tests. |
| TOL-09 | Tool and CLI send equivalent resolved requests. | Partial | The shared planner suggests parity, but the cross-surface equivalence test was deleted. |

## 12. CLI

| ID | Previous behavior | Current status | Discrepancy |
| --- | --- | --- | --- |
| CLI-01 | `topic create` and `topic create-child` with Source checkout defaults and explicit overrides. | Partial | Code paths exist, but no `effect-cli.test.ts` verifies them. |
| CLI-02 | Strict syntax rejects unknown, missing, and incompatible options before connecting. | Broken | Generic flag parsing accepts unknown names and can construct a client before later planning/config errors. |
| CLI-03 | Interactive `ask` accepts exact `yes` or `no`; non-interactive/JSON returns confirmation-required with exit code 3. | Missing | Topic CLI calls Operation Adapter without UI context. Awaiting confirmation returns as a non-success operation, with no interactive prompt and no old exit-code contract. |
| CLI-04 | Stable versioned JSON success and bounded stderr diagnostics. | Partial | JSON version 2 is permitted, but no current test locks output separation or bounds. |
| CLI-05 | Disconnect and Ctrl-C stop waiting without reporting success. | Broken | `cli-entry.ts` passes no AbortSignal and installs no signal handling. |
| CLI-06 | CLI waits up to its previous long deadline. | Broken | Shared adapter defaults to ten minutes; the previous CLI limit was six hours. |
| CLI-07 | Conflict and resolver failures retain bounded semantic details. | Partial | Typed failures exist below the CLI, but the adapter emits only a generic message and has no matrix tests. |
| CLI-08 | Executable package entry remains valid. | Present | `cli-entry.ts` remains the package binary. |
| CLI-09 | Operation list/show/cancel commands. | Added | Implemented. No direct CLI tests. |
| CLI-10 | Storage backup/verify/restore commands. | Added | Implemented. No direct CLI tests. |
| CLI-11 | Every created client is disposed on parse/config/planning failure. | Broken | Topic command creates the client before configuration/planning and has no surrounding `finally` until the wait adapter starts. |

## 13. Backend and infrastructure parity

| Area | Current status | Notes |
| --- | --- | --- |
| SQLite durable Topic and operation storage | Added | Strong transaction, recovery, and maintenance tests exist. |
| Durable Operation acceptance, recovery, cancellation, and retention | Added | Covered by current application/storage tests. |
| Repository clone, Worktree creation, and Recipes | Present | New provisioning and Git adapters cover core semantics. |
| Root and child Start Point safety | Present | Git control and planner retain exact-commit checks. End-to-end tool/CLI coverage is much thinner. |
| Desktop workspace, terminal, browser, and Main Agent launch adapters | Present | Infrastructure tests exist. Product policy and dashboard paths are partial. |
| Pull request observation and durable identity | Present | Adapter tests exist; dashboard presentation is broken. |
| State snapshot, revisions, overflow, and resync | Added | Current state/RPC tests cover these. Reconnect presentation is broken. |
| Process bounds and descendant cleanup | Added | Strong Effect process tests exist. |
| Action policy | Broken | Provisioning only; non-provision sensitive actions bypass it. |
| Rich Integration Status projection | Broken | Git computes counts, then observation maps the result to `status.kind` and discards counts. |
| Git operation conflict/pending projection | Broken | Domain projection stores only the operation kind. |
| Workspace/base-checkout display projection | Missing | Old dashboard facts are not part of current `WorkSnapshot`. |
| Legacy migration machinery | Intentional removal | Required after approved cutover. |

## 14. Current code that exists but is not connected to the product

These items can look complete in tests while remaining unavailable to users:

1. `EffectDashboardRuntime.requestCancelSetup`, `confirmCancelSetup`, and `rejectCancelSetup` have
   tests, but no dashboard action calls them.
2. `EffectDashboardRuntime.resetIntegrationBranch` has a test, but no dashboard action calls it.
3. `observationFreshnessLabel`, `interruptedSetupLabel`, and `integrationBranchLabel` have tests,
   but no production view imports them.
4. `operationUpdates` is maintained by operation watches, but no view reads it.
5. Change Parent, Remove Parent, Move in Chain, and Reset Integration Target exist in the Atomic
   Command protocol and backend, but the action rail has no corresponding actions or chooser.
6. Provisioning supports `attempt: "retry"`, but there is no dashboard Retry Setup action or client
   planner for it.
7. Shimmer scheduling advances runtime state, but the renderer reads a separate view-state phase.

## 15. Highest-risk convergence gaps

These should be treated as correctness or safety work before visual polish:

1. **Policy bypass for terminal, Main Agent open/reset, and delete.**
2. **Missing dashboard creation, child creation, and Retry Setup.**
3. **Missing chain-maintenance UI despite existing backend commands.**
4. **Topic Agent delayed/noisy re-attachment after lease loss.**
5. **CLI confirmation, cancellation, timeout, and disposal regressions.**
6. **Loss of rich Integration Status and Git operation facts at the snapshot schema boundary.**
7. **Dashboard code that is tested in isolation but is not wired to the production view.**

## 16. Evidence sources for the convergence epic

The future convergence epic should treat these as source material:

- Previous product contract: `33500e4:agent/extensions/work/README.md`
- Previous dashboard model and renderer: `33500e4:agent/extensions/work/client/dashboard.ts`
- Previous dashboard component: `33500e4:agent/extensions/work/client/dashboard-component.ts`
- Previous dashboard behavior matrix: `33500e4:agent/extensions/work/client/dashboard.test.ts`
- Previous Topic Agent contract: `33500e4:agent/extensions/work/topic-agent/reporter.test.ts`
- Previous root and child tool contracts: `33500e4:agent/extensions/work/client/*-tool.test.ts`
- Previous CLI contract: `33500e4:agent/extensions/work/client/cli.test.ts`
- Migration requirements: `.scratch/work-effect-v4/PRD.md`, especially Product compatibility and Dashboard and clients
- Current product adapters: `agent/extensions/work/client/` and `agent/extensions/work/topic-agent/`
- Current backend interfaces: `agent/extensions/work/application/`, `agent/extensions/work/infrastructure/rpc/`, and `agent/extensions/work/domain/model.ts`
