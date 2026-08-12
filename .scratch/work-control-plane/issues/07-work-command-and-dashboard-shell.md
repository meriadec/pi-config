# Add the /work command and full-screen dashboard shell

Status: done

## Context

Read the PRD and issues 01-06. Follow Pi TUI guidance: use `ctx.mode === "tui"` before `ctx.ui.custom()`, keep every rendered line within width, request renders after state changes, and clean up subscriptions.

## Objective

Register `/work`, complete first-run `WORK_BASE` setup, and show a live full-screen topic dashboard backed only by the typed daemon client.

## Scope

Extension entry:

- Add `agent/extensions/work/index.ts` as the auto-discovered entry.
- Register `/work` only once.
- In non-TUI mode, return a clear message instead of trying to render a custom component.
- Connect/start `workd` only when `/work` is invoked or when an explicit topic-agent environment is active. Do not start resources from the extension factory.

First-run setup:

- If config is missing or has no `workBase`, show a focused setup form before the dashboard.
- Accept an absolute directory path, expand `~` deliberately, validate that it exists and is writable, and save through the shared config store.
- Allow cancel without creating partial config.
- The main dashboard is inaccessible until setup succeeds.

Dashboard shell:

- Use `ctx.ui.custom()` as a full-screen experience.
- Render a topic table with name, repository, setup state, and main-agent state.
- Include clear loading, empty, reconnecting, daemon failure, and corrupt-topic diagnostic states.
- Load one snapshot, subscribe to daemon events, and reduce events into local view state.
- Preserve selection by topic ID across updates and sorting.
- Support `j`/`k`, Up/Down, `h`/`l`, Left/Right, Enter, `q`, and Escape.
- Enter opens a concise detail sidebar for the selected topic. Actions can be placeholders in this issue.
- `q` closes the details sidebar. Escape exits `/work` immediately from the normal dashboard.
- Include key hints and truncate/wrap safely for narrow terminals.
- React to terminal resize and theme invalidation.
- Close the client subscription when the component exits and on session shutdown.

Keep state reduction, layout calculation, and rendering testable without a live terminal.

## Tests

Add tests for:

- TUI-only guard.
- Config setup validation, save, and cancel.
- Empty, loading, connected, reconnecting, and diagnostic view models.
- Event reduction and selection stability.
- Vim and arrow navigation.
- Sidebar open/close behavior.
- Narrow and wide rendering with no line exceeding width.
- Subscription cleanup after Escape and shutdown.

Run `bun run check`.

## Acceptance criteria

- `/work` starts the daemon on demand and renders hydrated topics live.
- First use requires and persists `WORK_BASE` before the main view.
- The component is navigable without a mouse and does not leak sockets or timers.
- UI code does not read topic files or invoke system commands directly.
- The repository harness passes.

## Dependencies

- Issue 04
- Issue 06

## Comments
