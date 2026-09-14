# Use Effect v4 for the Work control plane

Status: accepted

The Work control plane will use an exactly pinned Effect v4 release candidate for side effects, dependency layers, typed failures, structured concurrency, resource scopes, schedules, and local observability. Pure domain planning stays as ordinary deterministic TypeScript. External Pi, TUI, and executable callbacks use thin runtime adapters, and direct module imports keep the auto-discovered extension lazy.

## Consequences

The migration can use stable and `effect/unstable/*` modules when they pass Work contract tests. If an unstable adapter fails a required contract, one custom Effect-native adapter can replace it; parallel fallback implementations are not retained. Bun remains the test runner. The final Work implementation has no Promise lock queues, manually owned timers, detached Promise tasks, or unscoped long-lived resources outside documented adapters.
