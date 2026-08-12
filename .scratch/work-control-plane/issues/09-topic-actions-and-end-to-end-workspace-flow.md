# Wire topic details and workspace actions end to end

Status: done

## Context

Read the PRD and issues 01-08. The dashboard already opens topic details. This issue replaces action placeholders with daemon-backed behavior.

## Objective

Complete the version 1 daily interaction: access a topic workspace, open terminals, open or focus the main agent, retry setup, and delete only the topic record.

## Scope

Detail sidebar:

- Show name, branch, repository, base checkout, `wt`-reported worktree path, setup state, main-agent state, current workspace when observable, and one concise diagnostic.
- Keep the default view concise. Truncate paths safely and expose enough detail to identify the subject.
- Provide keyboard focus between list, detail, and actions with `h`/`l`, Left/Right, `j`/`k`, Up/Down, and Enter.

Actions:

- Access Topic Workspace.
- Open Terminal.
- Open Main Agent.
- Retry Setup when eligible.
- Delete Topic.

Behavior:

- Call only typed daemon actions.
- Display action progress without freezing the topic list.
- Handle policy `ask` with a precise confirmation and `deny` as an unavailable action.
- Treat no empty i3 workspace as a clear informational result, not an error notification.
- On Open Terminal, select/focus the leased topic workspace and launch kitty in the worktree.
- On Open Main Agent, focus the live main-agent window or launch the deterministic resumable session.
- Reflect main-agent events live in both table and sidebar.
- Deleting a topic removes only `~/work/topics/<id>` after confirmation. The confirmation must state that branch, worktree, base checkout, Pi session, and open windows remain.
- If the selected topic is deleted, return focus safely to the nearest list row.
- Errors must be concise and must not expose raw command output.

Do not add PR, GitHub, rebase, development-server, or Kubernetes actions.

## Tests

Add reducer/component integration tests plus fake-daemon flows for:

- Action focus and invocation by Vim and arrow keys.
- Existing topic workspace focus.
- New terminal workspace allocation.
- Informational full-workspace result.
- Main-agent launch then focus without duplicate spawn.
- Live thinking/waiting/stopped state display.
- Policy confirmation and denial.
- Delete warning text and manifest-only result.
- Selection after deletion.
- Action errors and reconnect during an action.

Run `bun run check`.

## Acceptance criteria

- The PRD acceptance scenario works through injected end-to-end adapters.
- All mutations remain daemon-owned and policy-checked.
- Workspace exhaustion does not look like a failed operation.
- One topic cannot acquire two live main-agent sessions through repeated UI actions.
- The repository harness passes.

## Dependencies

- Issue 08

## Comments
