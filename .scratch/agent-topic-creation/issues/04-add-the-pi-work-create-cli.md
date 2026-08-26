# 04 — Add the `pi-work topic create` CLI

Status: ready-for-agent
Type: feature
Blocked by: 03
Affected extension: `work`

## Context

Shell users, scripts, and non-Pi agents need a stable client for daemon-owned Topic creation. The CLI must share resolution and policy behavior with the Pi tool instead of invoking Git provisioning itself.

The command can run for the full provisioning duration and can encounter several sequential `ask` policies.

## Scope

- Add a bounded CLI entry for `pi-work topic create` and a versioned executable or package entry that exposes the `pi-work` name without copying daemon logic.
- Support:
  - `--name <name>` as required;
  - `--repository <owner/repo>` as optional;
  - `--branch <branch>` as optional;
  - `--start-point <revision>` as optional;
  - `--source-checkout <path>` as optional, defaulting to the current directory;
  - `--json` for stable machine-readable output.
- Use the shared resolver from issue 01, then call `WorkClient.createTopic` with explicit resolved values.
- Start or connect to `pi-workd` through `SystemdWorkdManager`. Reuse the dashboard's setup and credential-forwarding boundaries where they apply.
- If `WORK_BASE` is not configured, return a direct setup instruction without editing config from a non-interactive process.
- Wait for `ready`, failure, timeout, cancellation, or confirmation-required. Use a provisioning timeout that is compatible with Repository Recipes.
- On an interactive terminal, print the daemon's exact confirmation text and require a direct yes/no answer for each `ask` step. Keep the connection and token alive while the user answers.
- In non-interactive or JSON mode, never approve an `ask` action. Return a structured confirmation-required outcome and a non-zero exit status.
- Print bounded progress and diagnostics. JSON mode writes one final object to stdout and diagnostics to stderr without leaking credentials or unbounded command output.
- Return Topic ID, name, repository, Branch, setup state, and Worktree path on success.
- Do not open a Main Agent or implement a policy-bypass flag.

## Acceptance criteria

- [ ] Both agreed example commands resolve to the expected explicit daemon request.
- [ ] Omitted repository, Branch, and Source checkout use the current checkout and shared normalization rules.
- [ ] An explicit repository and Branch work outside a Git checkout when no Start Point needs resolution.
- [ ] Human output is concise, and JSON output has a tested stable shape.
- [ ] Interactive `ask` waits for direct input and submits the matching confirmation token on the same client identity.
- [ ] Non-interactive mode cannot approve `ask`, and `deny` is always terminal.
- [ ] Ctrl-C closes the client, stops local waiting, and never reports success. Daemon reconciliation remains safe if provisioning already crossed a durable checkpoint.
- [ ] CLI parsing, exit codes, progress bounds, and systemd connection use injected seams in tests.
- [ ] The documented `pi-work` command resolves in the supported installation layout.
- [ ] `bun run check` passes.

## Validation

- CLI parser and renderer unit tests.
- Fake WorkClient tests for ready, conflict, ask/confirm/reject, deny, timeout, and disconnect outcomes.
- Temporary-repository test for current-directory inference.
- One daemon integration test that creates a ready Topic.
- Full harness.

## Comments
