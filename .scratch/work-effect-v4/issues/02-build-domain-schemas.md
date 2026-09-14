# Build branded domain schemas and typed failures

Status: ready-for-agent

Depends on: 01

Suggested commit: `refactor(work): define Effect domain schemas`

## Read first

- `../PRD.md`, especially Domain model and Error policy
- both `CONTEXT.md` files
- `agent/extensions/work/shared/domain.ts`
- pure modules under `agent/extensions/work/shared/`

## Objective

Create one canonical domain module with branded identities, Effect Schema codecs, immutable domain values, and module-specific typed failures. Keep deterministic planning pure.

## Scope

1. Define schemas and brands for Topic ID, Operation ID, client ID, request ID, Branch, repository, full commit SHA, absolute path, protocol version, and storage schema version.
2. Define schemas for Topic, setup state including Interrupted Setup, Main Agent durable identity, Integration Target, Start Point, Recipe, policy, Pull Request identity, and safe public failure details.
3. Separate durable records from observed-state records.
4. Replace broad string-code error construction in new code with small tagged error families for domain, storage, process, Git, RPC, policy, and operation concerns.
5. Preserve pure Integration Chain, Partition, policy, status, and dashboard planning functions as ordinary deterministic TypeScript.
6. Add codec round-trip, rejection, redaction, and compatibility tests.
7. Provide temporary adapters only where old code must compile before cutover.

## Interface rule

Callers receive decoded domain values. They do not repeatedly validate strings. Private local capabilities are opaque or redacted and have no default string rendering.

## Non-goals

- SQLite tables
- RPC declarations
- moving all current files only to match the final directory drawing
- wrapping pure functions in `Effect.sync`

## Acceptance

- New application and infrastructure code can import one canonical domain model.
- Invalid external data cannot construct branded domain values.
- Error schemas contain bounded public data and preserve an internal cause where required.
- Existing pure behavior remains covered.
- `bun run check` passes.

## Comments
