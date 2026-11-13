# wait extension: notes

## Choices

- `wait_for` BLOCKS. The tool call stays open until the event, so T3 shows the thread as working, and its Stop button aborts the wait through the tool `AbortSignal`. The agent does not end its turn; when the call returns it goes on with the user's instructions (rebase after a merge, ping the user after a review).
- No T3 wake-up is used any more (`watch_pull_request`, `schedule_task`, `sendUserMessage`). PR events are polled with `gh pr view --json` every 30 s, inside the tool: no LLM tokens. T3 has no filter and no merge event, so its watch could not do this.
- Events: `pr.merged` (also ends on closed without merge), `pr.checks.done` (no check pending; lists failures; "no checks" counts as done only after 2 min), `pr.review` (new non-pending review or comment compared with the first poll; optional `reviewer`, case-insensitive part of the login), `pr.approved`, `time`, `process.exit`, `http.ready`.
- A PR event on a PR that is no longer open ends at once and says why (except `pr.merged`).
- `gh` errors back off (30 s doubling, max 5 min). 5 failures in a row end the wait with an error.
- A queued message (`ctx.hasPendingMessages()`, polled every 2 s) ends any wait early, so a `time` wait is a maximum, not a fixed delay. This lets a finished delegated task wake the agent.
- No maximum duration. The wait ends with the turn: `/reload`, a closed session or Stop. Nothing is saved to disk; the agent can start the wait again.
- Several `wait_for` calls in parallel are allowed (each blocks its own call). `wait_cancel` aborts one by id. The footer status lists them.
- `http.ready` waits for ONE answer with a status below 500. It does not check the body and does not retry. Tested against a real `Bun.serve` in `probe.test.ts`.
- `process.exit` takes `pid`, or `match`: text in the command line of exactly one process that carries this session's tag. A shell that only wraps a matching child is ignored. With 0 or 2+ matches the tool returns an error with up to 5 candidates.
- The leftover scan runs at `agent_end` only after a bash command that may start a background process (` &` not part of `&&`, `&>`, `>&`; `nohup`; `setsid`; `disown`; or a long-lived command such as `dev`, `serve`, `watch`), and in `wait_list`. It lists only processes of the current user (`ps -u`), reads at most 2000, reports at most 20, and stops after 1.5 s.
- The sleep hint hints at `sleep` of 20 s or more, also inside `timeout N sleep M` and `bash -c '...'`. It is soft: it never blocks a command.

## To verify by hand

- That Pi and T3 do not time out a tool call that runs for hours.
- That the T3 Stop button reaches `execute` as an abort of `signal`.

## Assumption

One Pi session per process. This holds for the `pi` CLI and for the T3 Pi adapter. The session tag is in `process.env`, so two sessions in one process would share it. The tag is set again before each bash `tool_call`.

## Follow-ups (not done)

- Event "output matches" (a line of a log or process output matches a regex).
- Event "command done" (a command that the session ran ends, with its exit code).
- Save waits so they survive a reload (needs a state file and a restart rule).
