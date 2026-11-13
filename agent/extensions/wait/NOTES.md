# wait extension: notes

## Choices

- All timers are local. T3 `schedule_task` was used for timers of 60 s or more, but it makes a global automation in T3 for every project that never goes away (removed 2026-11). Cost: a timer ends with the session. Better primitive to find: a thread-bound, self-deleting wake-up.
- Local waits (process, URL, timers) are not saved. They end when the session ends or reloads. This is said in the `wait_for` description and result text.
- PR watches: `pr.review` and `pr.checks` start the same `watch_pull_request`. T3 has no filter: it wakes on ANY PR event. T3 does not wake on merge, so there is no `pr.merged`.
- `http.ready` waits for ONE answer with a status below 500. It does not check the body and does not retry. Tested against a real `Bun.serve` in `runner.test.ts`.
- `process.exit` takes `pid`, or `match`: text in the command line of exactly one process that carries this session's tag. A shell that only wraps a matching child is ignored. With 0 or 2+ matches the tool returns an error with up to 5 candidates.
- The leftover scan runs at `agent_end` only after a bash command that may start a background process (` &` not part of `&&`, `&>`, `>&`; `nohup`; `setsid`; `disown`; or a long-lived command such as `dev`, `serve`, `watch`), and in `wait_list`. It lists only processes of the current user (`ps -u`), reads at most 2000, reports at most 20, and stops after 1.5 s.
- The sleep hint hints at `sleep` of 20 s or more, also inside `timeout N sleep M` and `bash -c '...'`. It is soft: it never blocks a command. Real history (`bun analytics/cli.ts polling` data): many hits are a `sleep 20`..`25` after a background server start. This is a startup pause; the hint is weaker there.

## Assumption

One Pi session per process. This holds for the `pi` CLI and for the T3 Pi adapter. The session tag is in `process.env`, so two sessions in one process would share it. The tag is set again before each bash `tool_call`.

## Follow-ups (not done)

- Event "output matches" (a line of a log or process output matches a regex).
- Event "command done" (a command that the session ran ends, with its exit code).
- Save local waits so they survive a reload (needs a state file and a restart rule).
- Show local waits in T3 (see `docs/design/t3-waiting-list.md`).
