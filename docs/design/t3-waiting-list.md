# Design note: T3 "waiting list"

Status: proposal. Author: research sub-agent. No T3 Code file was changed.
Read: `~/git/t3code` at commit `9e8553853` (2026-11-04). The tree was dirty
(keybinding files in `apps/web`, `packages/contracts`, `packages/shared`). None of those
files is used in this note.
Mock of the three display levels: [experiments/waits/mock-d.html](../../experiments/waits/mock-d.html).
Pi side: `agent/extensions/wait/`, report in `experiments/waits/REPORT.md`.

Goal: a thread shows what it waits on now, with a Stop button, on web, desktop and mobile.
Desktop uses the web app, so "web" below also means desktop.

## Summary

Most of level B **exists already**. T3 has a "pending background work" list with a Stop
button on web and mobile. It already contains PR watches. It does **not** contain scheduled
tasks, and it has no per-row Stop. Level C can reuse this list: a registered wait becomes
one more pending task.

## 1. What T3 already stores

### 1.1 PR watches

- A watch lives inside the thread's PR link: `ThreadPullRequestLink.watch`
  (`packages/contracts/src/threadPullRequest.ts:82-104` for `ThreadPullRequestWatch`,
  `:106-119` for the link). It is part of the thread read model:
  `pullRequests` on the thread (`packages/contracts/src/orchestrationV2.ts:456`, `:2084`).
- Events and commands: `thread.pull-request.watch` (`orchestrationV2.ts:3085`) and
  `thread.pull-request-watch.sync` (`:3410`). The reducer is in
  `apps/server/src/orchestration-v2/Orchestrator.ts:3863-3940`.
- The MCP tools `watch_pull_request` and `unwatch_pull_request` call this command
  (`apps/server/src/mcp/toolkits/pullRequests/handlers.ts:262-300`, `:523-524`; tool text in
  `.../pullRequests/tools.ts:400-412`). They are hidden from subagents.
- The wake-up: `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` (watch list at
  `:585`, command at `:282-290`). It sends a message to the thread.
- A user can already toggle a watch: `watchThreadPullRequest`
  (`packages/client-runtime/src/operations/commands.ts:1117-1131`). UI: web
  `apps/web/src/components/pullRequest/ThreadPullRequestsPanel.tsx:400`, mobile
  `apps/mobile/src/features/threads/useLinkedPullRequestActions.ts:45`. Both check the
  capability `threadPullRequestWatch` (`packages/contracts/src/environment.ts:131`).

### 1.2 Scheduled tasks

- Model: `ScheduledTask` with `threadId: NullOr(ThreadId)`, `enabled`, `schedule`,
  `nextRunAt`, `lastRunStatus` (`packages/contracts/src/scheduledTask.ts:227-252`).
- Storage: an SQL table, not thread events. Service:
  `apps/server/src/scheduledTasks/ScheduledTaskService.ts` (bound-thread run at `:885-950`;
  cleanup when the thread is deleted at `:1442-1454`). Migrations:
  `apps/server/src/persistence/Migrations/057_ScheduledTaskWebhooks.ts`.
- API: WS/RPC `scheduledTasks.subscribe | upsert | setEnabled | delete | runNow`
  (`packages/contracts/src/rpc.ts:541-546`, `:1902-1910`). Client atoms:
  `packages/client-runtime/src/state/server.ts:1326` (`scheduledTasksLive`) and
  `:1546-1571` (commands). The subscription returns **all** tasks of the environment;
  clients filter by `threadId`.
- MCP: `schedule_task` (`apps/server/src/mcp/toolkits/orchestrator/tools.ts:159`; schema
  `packages/contracts/src/orchestratorMcp.ts:668-690`, with `boundThreadId`).
- Web shows bound tasks in the thread details panel:
  `apps/web/src/components/chat/ThreadAutomationsPanel.tsx:60-110` (list, enable switch,
  "run now"). It is a side panel, not a status strip. Mobile reads the task list only to
  label a queued message (`apps/mobile/src/features/threads/ThreadQueueControl.tsx:70-100`).
  I found **no** mobile list of bound tasks.

### 1.3 "Background activity" and pending background work

- The text "Background activity updated" is a fixed notification summary for a wake message
  from a provider: `apps/server/src/orchestration-v2/ProviderContinuationService.ts:190-206`
  (message `notification` = `{source:{kind:"background_task"}, outcome:"updated", ...}`).
  Contract: `OrchestrationV2Notification` (`orchestrationV2.ts:1276-1282`).
  This is what the user sees when a **local** Pi wait fires.
- Pending work record: `OrchestrationV2PendingBackgroundTask`
  (`orchestrationV2.ts:1005-1038`): `taskId`, `description`, `kind`
  (`subagent | command | monitor | background_task`), `awaited`. Stored on the provider
  thread (`:1094`) and copied to the thread shell (`:2116`).
- Derivation: `derivePendingBackgroundWork`
  (`packages/shared/src/orchestrationV2PendingBackgroundWork.ts:228-290`). It returns an
  empty list while a run is active (`:244`). It merges provider tasks, running
  command/subagent turn items, and PR watches (`pullRequestWatchTasks`, `:292-312`, kind
  `monitor`, `awaited: true`). The server calls it for the shell at
  `apps/server/src/orchestration-v2/ProjectionStore.ts:1585-1592`. The web calls it for the
  open thread at `apps/web/src/components/ChatView.logic.ts:1559-1578`.
- Rule: a task with `awaited: true` keeps the thread "unsettled"
  (`orchestrationV2PendingBackgroundWork.ts:89-112`; `ThreadSettlementService.ts:156`).
- The Pi provider adapter always reports an empty task list
  (`packages/provider-pi/src/server/adapter.ts:2362`, `:3169`). It only reports "has pending
  work" while it holds a wake (`:2471-2475`). So Pi local waits are invisible. This matches
  the proven fact (4).

### 1.4 How the UI shows it today

- Web: `backgroundWorkNowItem` in
  `apps/web/src/components/chat/ThreadActivityBanners.tsx:157-232`. It shows a title
  ("Waiting on a monitor"), a label list, an elapsed timer, **one Stop button for all
  tasks**. It is wired in `apps/web/src/components/chat/useThreadLifecycle.tsx:405-460` and
  `:595-604`.
- Mobile: a status pill in `apps/mobile/src/features/threads/ThreadDetailScreen.tsx:785-812`
  with label, Stop, and a tap that opens
  `apps/mobile/src/features/threads/ThreadBackgroundWorkSheet.tsx:34-143` (rows: icon,
  label, kind; **no state, no Stop per row**).
- Text of the title and label rules, shared by both:
  `presentPendingBackgroundWork`
  (`packages/client-runtime/src/state/threadExecution.ts:401-450`).
- Stop: `interruptThreadTurn` (`threadExecution.ts` is state; command in
  `packages/client-runtime/src/operations/commands.ts:784-880`). With a live run or live
  tasks it sends `thread.stop` or `run.interrupt`. With only PR watches left (no run) it
  sends one `thread.pull-request.watch {watching:false}` per watched PR (`:850-868`).
  Mobile uses the same function (`ThreadDetailScreen.tsx:655-690`).
- PR status (state, checks, review) shows in the PR panel (see 1.1) and in
  `ThreadPullRequestSnapshot` (`threadPullRequest.ts:35-52`).

### 1.5 Push and awareness path

- `apps/server/src/relay/AgentAwarenessRelay.ts` publishes thread phases to the relay.
  Phase rules: `packages/shared/src/agentAwareness.ts:62-135`. A completed run with an
  awaited pending task is "running" (`:116`). Mobile side:
  `apps/mobile/src/features/agent-awareness/*` (registration, permissions, deep link
  `/threads/<env>/<thread>`).
- A fired wait that starts a run goes through this path as a normal phase change.

### 1.6 Not found

- No API that lists "waits" as one thing. No event type "wait".
- I did not find a path where a provider tells T3 about a _new_ pending task from outside
  a turn (the MCP tools only write threads through commands).
- I did not check whether `thread.stop` ends PR watches (`Orchestrator.ts:603`,
  `:10785+`). The client code ends them itself in the no-run case.
- I did not run the app. I did not check whether push fires on every phase change
  (only read the relay and phase code).

## 2. Level B: "Waiting" strip, no new concept

Observation: a strip already exists. Level B is small: add scheduled tasks, add state and a
per-row Stop. No server change is needed.

### 2.1 Data (no server query, no contract change)

Scheduled tasks are not in the thread read model. Do **not** add them to
`derivePendingBackgroundWork`: it is a pure function without the SQL table. Merge on the
client, where `scheduledTasksLive` is already subscribed.

Add in `packages/client-runtime/src/state/threadExecution.ts` (next to
`presentPendingBackgroundWork`, `:401`):

```ts
type WaitingItem =
  | { source: "task"; task: OrchestrationV2PendingBackgroundTask /* PR watch id → prUrl */ }
  | { source: "scheduled"; task: ScheduledTask }; // enabled, threadId === this thread
function deriveWaitingItems(input: { tasks; scheduledTasks; threadId }): WaitingItem[];
```

State text per row: PR watch = "Watching #123" (+ checks/review from the link snapshot);
scheduled = "Runs in 20 min" from `nextRunAt`; command/subagent = existing label.
Keep only scheduled tasks with `enabled` and `nextRunAt != null`.

Contracts used as they are: `ScheduledTask`, `OrchestrationV2PendingBackgroundTask`,
`ThreadPullRequestLink`. New schema names: **none**.

Per-row Stop, all existing commands:

| Row               | Stop action                                                               | Existing code             |
| ----------------- | ------------------------------------------------------------------------- | ------------------------- |
| PR watch          | `thread.pull-request.watch {watching:false}`                              | `commands.ts:1117`        |
| Scheduled task    | `scheduledTasks.setEnabled {enabled:false}` (keeps it, pause) or `delete` | `server.ts:1552`, `:1558` |
| Subagent          | `subagent.stop`                                                           | `commands.ts:805-812`     |
| Command / monitor | whole-thread `interruptThreadTurn` (no single-task stop found)            | `commands.ts:784`         |

### 2.2 Web (also desktop)

- Extend `backgroundWorkNowItem` (`ThreadActivityBanners.tsx:157`) to take
  `scheduledTasks` and per-row `onStop`. Today it shows one line for all items; add the
  expanded list that its popover styles already allow (`in-data-[slot=popover-popup]` classes,
  `:175-185`). I did not read the `ThreadNowItem` renderer; check it first.
- Feed it from `useThreadLifecycle.tsx:595` with `useEnvironmentQuery(
serverEnvironment.scheduledTasksLive(...))`, as `ThreadAutomationsPanel.tsx:68` does.
- Keep `ThreadAutomationsPanel` for editing. The strip is for "now".

### 2.3 Mobile

- Extend `ThreadBackgroundWorkSheet.tsx:34-143`: add the scheduled rows, a state line and
  a Stop button per row (`BackgroundWorkRow`, `:104`). Rename title to "Waiting".
- In `ThreadDetailScreen.tsx:716` and `:785-812` pass the merged list so the pill counts
  scheduled tasks too. The pill's Stop stays "stop all".
- Read tasks with the same atom: `ThreadQueueControl.tsx:82`.

### 2.4 Size and risk

- About 6 files, 250-350 lines with tests: `threadExecution.ts` (+60),
  `threadExecution.test.ts` (+60), `ThreadActivityBanners.tsx` (+60),
  `useThreadLifecycle.tsx` (+20), `ThreadBackgroundWorkSheet.tsx` (+70),
  `ThreadDetailScreen.tsx` (+20).
- Risk 1: the strip is hidden while a run is active (`derivePendingBackgroundWork:244`).
  Keep that: a thread that works is not "waiting". But a bound scheduled task exists at
  that time too. Decide if the strip shows it (open question 1).
- Risk 2: `scheduledTasksLive` returns all tasks. For a phone on a big environment this is a
  large payload for a small strip. Fine today (web and mobile already subscribe).
- Risk 3: "Stop" for a recurring task. Pause (`enabled:false`) is safer than delete.
- Risk 4: permissions. The web uses `AuthOrchestrationOperateScope`
  (`useThreadLifecycle.tsx:415-419`). Scheduled task commands have their own permission
  atoms (`ThreadAutomationsPanel.tsx:64`). Gate each row on its own permission.
- Risk 5: one-shot tasks. I did not check what `enabled` and `nextRunAt` hold after a
  `once` task has run. Check `ScheduledTaskService.ts` before filtering on them.

## 3. Level C: a `Wait` object for events T3 cannot see

Reuse the PR-watch pattern. A PR watch is a record on the thread that the derive step turns
into a pending task with `awaited: true`. A `Wait` does the same, so levels B and C share
one UI.

### 3.1 Smallest interface

Three MCP tools on the existing thread toolkit
(`apps/server/src/mcp/toolkits/thread/tools.ts`, registered at `McpHttpServer.ts:1122`):

```
register_wait { kind: "process_exit" | "http_ready" | "timer" | "other",
                label: string (<=120), awaited?: true,
                expiresInSeconds: 60..86400, waitId?: string }  → { waitId }
update_wait   { waitId, label?, expiresInSeconds? }            // also the heartbeat
end_wait      { waitId, outcome: "fired" | "cancelled" | "failed", detail?: string }
```

Rules: the thread comes from the MCP session (like `watch_pull_request`, `handlers.ts:357`),
not from a parameter. Hide from subagents with `McpInvocationContext.hiddenFromSubagents`
(`tools.ts:400-412` shows the use). `waitId` is chosen by the caller, so a retry is safe.
Limit: 20 open waits per thread.

Server pieces:

- Contract: `ThreadWait` struct (`waitId`, `kind`, `label`, `awaited`, `startedAt`,
  `lastSeenAt`, `expiresAt`, `providerSessionId`). Add `waits: optional(Array(ThreadWait))`
  to the thread record next to `pullRequests` (`orchestrationV2.ts:456`, `:2084`).
- Commands and events: `thread.wait.register | update | end`, reduced like
  `thread.pull-request.watch` (`Orchestrator.ts:3863-3940`). New file
  `apps/server/src/mcp/toolkits/thread/waits.ts` for the handlers.
- Derive: add `waits` to `derivePendingBackgroundWork` input, with a `waitTasks()` twin of
  `pullRequestWatchTasks` (`orchestrationV2PendingBackgroundWork.ts:292`). Output kind
  `monitor` or `background_task`, `taskId: "wait:<id>"`. Then web, mobile, settlement
  (`ThreadSettlementService.ts:156`) and awareness (`agentAwareness.ts:116`) work unchanged.
- Stop: for `wait:` ids, the client sends `thread.wait.end {outcome:"cancelled"}`.
  The Pi extension must see this (see section 6): T3 does not own the process. Two ways:
  (a) the next `update_wait` returns `{ cancelled: true }`; (b) T3 sends the thread a
  short message "Wait X was stopped by the user". Use (a) and (b) together.
- Capability flag `threadWaits` in `environment.ts` (like `:131`) so old servers hide it.

### 3.2 Reuse of level B UI

The strip reads `pendingBackgroundTasks`. A wait is a task there. The only UI change: show
`waitId`-kind rows with the `Wait` label and call `thread.wait.end` as their Stop.

### 3.3 Crash, restart, stale waits

- Heartbeat: each wait has `expiresAt`. The Pi extension calls `update_wait` while the wait
  lives, for example every `expiresInSeconds / 3`. No heartbeat means expiry.
- Reaper: a small reactor (model: `PullRequestWatchReactor.ts`) ends expired waits with
  `outcome:"failed", detail:"expired"`. The derive function has no clock, so expiry must be
  an event, not a filter.
- Session bound: when a provider session ends, end its waits. The orchestrator already
  clears provider-thread tasks when no live session remains
  (`Orchestrator.ts:10523-10545`, using `hasLiveSession`). Hook the same place.
- T3 server restart: waits are events, so they persist. After restart, wait for the
  heartbeat; if none comes before `expiresAt`, expire. Restart notes for lost work already
  exist (`OrchestrationV2RestartCancelledBackgroundWork`, `orchestrationV2.ts:637-645`,
  `RestartBackgroundNote.ts`); reuse the label rule.
- Pi crash: no heartbeat → expiry within one TTL. The Pi extension should use short TTL
  (5 min) with heartbeat.

### 3.4 Mobile push

- When a wait fires, Pi calls `end_wait {outcome:"fired"}` and then sends the wake message.
  The message makes a run; the run changes the thread phase and the existing relay
  publishes it (`AgentAwarenessRelay.ts`, `agentAwareness.ts:62-135`). No new push code.
- An open wait with `awaited: true` keeps the phase "running" (`agentAwareness.ts:116`),
  like a PR watch today. That is the wrong word for "waiting". Open question 3.
- Optional later: a push for `end_wait outcome:"failed"` (expired/crashed). Not in the first PRs.
- Not verified: whether the mobile app shows a push for every phase.

### 3.5 Alternative (not recommended now)

Teach `packages/provider-pi/src/server/adapter.ts` to read waits from Pi RPC events and
fill `pendingBackgroundTasks` (`:2362`). No new MCP tools, but it needs a Pi-side event
protocol and only works for the Pi provider. The MCP route works for every provider.

## 4. Order and first PR

1. **PR 1 (level B, client only):** scheduled tasks in the strip, state text, per-row Stop
   for PR watch and scheduled task, mobile sheet rows. About 300 lines, no server change.
2. PR 2 (level B+): per-row Stop for a command/monitor if a single-task stop exists in the
   provider runtime. Not found today; skip if it needs provider work.
3. PR 3 (level C server): `ThreadWait` contract, commands, reducer, derive, capability.
4. PR 4 (level C tools): three MCP tools, reaper, session-bound cleanup.
5. PR 5: Pi extension reports waits (section 6).

Acceptance checks for PR 1 (phone, mobile app on a dev server):

1. In a thread, ask the agent to "remind me in 20 minutes" and end its turn. Open the
   thread. The pill shows "Waiting · …" and the sheet lists the reminder with "Runs in ~20 min".
2. Tap Stop on that row. The row goes away. After 20 minutes nothing happens.
3. Ask the agent to watch a PR. The sheet lists "Watching pull request #N". Stop on that row
   ends the watch (the PR panel shows "not watching").
4. Two waits at once: Stop on one row leaves the other.
5. While the agent works (run active), the strip does not show a fake "Waiting".
6. A thread with no waits shows no strip. A viewer without operate permission sees rows
   but the Stop buttons are disabled.
7. Same checks in the web app at phone width.

## 5. Open questions

1. Show a bound scheduled task while the agent works, or only when idle?
2. Stop on a recurring task: pause (`enabled:false`) or delete?
3. Should an open wait show as "Waiting" in push and in the sidebar, not "Agent is working"?
4. Is a per-thread limit of 20 waits and a 24 h TTL right? Who owns the TTL: Pi or T3?
5. Should T3 or Pi own the "fired" wake message? Today Pi sends it. T3 could send it
   when `end_wait outcome:"fired"` arrives, and then there is one path for all providers.

## 6. What the Pi side must change

Only after T3 has the tools. Until then, nothing changes.

- In `agent/extensions/wait/index.ts`, after `getRunner().add(...)`: look for the T3 tool
  `register_wait` with the existing `callT3` helper (matches suffix `__register_wait`).
  If it is missing or fails, continue silently. Local waits keep working as today.
- Use the local wait id as `waitId`. Send `label` from the spec (`pid 4242 vite`,
  `http://localhost:5173`).
- Add a heartbeat in `LocalRunner` (`runner.ts`): one interval per runner, calls
  `update_wait` for each live wait. Start it at the first wait. Stop it at the last wait and
  in `session_shutdown`.
- On fire (`fire` in `index.ts`): call `end_wait {outcome:"fired"}` first, then
  `pi.sendUserMessage(...)`. On `wait_cancel` and `stopAll`: `end_wait {outcome:"cancelled"}`.
- If `update_wait` returns `cancelled: true`, cancel the local wait.
- The leftover-process note (`agent_end` hook, `procscan.ts`) stays. Later it could become
  waits of kind `other` with `awaited` unset, so dev servers show in the same list.
- Add tests with a fake `ctx.tools`: absent tool → no error; present tool → one register,
  heartbeats, one end.
