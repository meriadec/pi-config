# 05 — Narrow the dashboard interface

Status: ready-for-agent
Type: refactor
Blocked by: 03
Affected extension: `work`

## Context

`client/dashboard.ts` exports the complete dashboard state and many wizard, completion, selection, layout, shimmer, and rendering helpers. The extension root re-exports the file. Tests can depend on nearly every implementation decision, so the dashboard interface is close to the size of its implementation.

## Scope

- Define a small dashboard model interface around initialization, semantic input or event updates, effects, and rendering.
- Keep daemon commands as returned effects so the model stays deterministic and does not create dependencies.
- Keep reconnect, timers, TUI `Input`, command execution, and lifecycle in the dashboard adapter.
- Make wizard representation, repository completion, sorting, selection stabilization, layout, rendering helpers, and shimmer calculation internal implementation details.
- Split model and renderer files only where the split improves locality; do not expose the internal seam from the extension root.
- Replace `export *` from the extension entry with intentional exports required by production callers.
- Replace helper-level tests with behavior tests through the dashboard model interface. Keep renderer width and TUI lifecycle tests at their natural interfaces.
- Preserve all keyboard behavior, selection behavior, confirmation behavior, reconnect retries, and display output.

## Acceptance criteria

- [ ] Production callers use a small dashboard model interface and do not construct internal state fields.
- [ ] Dashboard Actions are expressed through control-plane commands or presentation-neutral effects, not a second copied client method list.
- [ ] Internal wizard, sorting, completion, layout, and shimmer helpers are not exported from `work/index.ts`.
- [ ] Tests prove existing behavior through model updates, effects, rendering, and the TUI adapter.
- [ ] Narrow and wide renders stay within terminal width.
- [ ] Reconnect retries keep one stable request ID.
- [ ] Existing Topic list, action rail, Focus, PR, and Main Agent behavior remains unchanged.
- [ ] `bun run check` passes.

## Validation

- Dashboard model behavior tests.
- Golden or structural rendering tests for narrow and wide layouts.
- Dashboard adapter tests for TUI input, reconnect, timers, and disposal.
- Full harness.

## Comments
