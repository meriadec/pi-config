# Build the strict Work configuration module

Status: done

Depends on: 01, 02

Suggested commit: `refactor(work): add strict Effect configuration`

## Read first

- `../PRD.md`, especially Configuration and Integration Branch ownership
- `agent/extensions/work/shared/config-store.ts`
- configuration parsing in `agent/extensions/work/shared/domain.ts`
- setup behavior in `agent/extensions/work/client/setup.ts`

## Objective

Create a deep Effect configuration module for strict, versioned, human-authored JSON. The daemon must never write inferred repository state into this file.

## Scope

1. Define the next strict configuration schema and its exact allowed fields.
2. Keep Work Base, policy overrides, Repository Recipes, Base checkout overrides, and optional Integration Branch overrides.
3. Add a pure version-1-to-next-version migration used later by the storage migration tool.
4. Reject unknown fields after migration.
5. Implement scoped, private, atomic file reads and explicit writes through Effect FileSystem.
6. Keep manual edits supported. A normal read must not rewrite the file.
7. Define reload behavior: startup validation, explicit refresh, and command-time reload for policy-sensitive work.
8. Return the last valid configuration only for display after a later invalid edit; reject the affected command and publish a safe diagnostic.
9. Add a temporary Promise adapter only if old code needs it before production cutover.

## Invariants

- Configuration contains no inferred Integration Branch value unless the human selected it as an override.
- Invalid configuration never falls back to permissive policy defaults.
- Writes preserve private directory and file modes.

## Acceptance

- Versioned migration is deterministic and tested.
- Unknown fields and malformed values fail with precise bounded errors.
- Configuration reload tests cover valid-to-invalid and invalid-to-valid edits.
- Existing setup behavior remains available until cutover.
- `bun run check` passes.

## Comments
