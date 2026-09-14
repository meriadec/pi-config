# Cut production Work over to Effect

Status: needs-info

Depends on: 23 human approval

Suggested commit: `feat(work): cut over to Effect control plane`

## Read first

- `../PRD.md`
- the approved receipt in issue 23 Comments
- all new daemon, client, dashboard, tool, CLI, and Topic Agent entry modules

## Objective

Switch every production Work entry point to the new Effect runtime while retaining the isolated importer and old implementation for one short verification window.

## Scope

1. Verify issue 23 contains explicit human approval. Stop with `needs_human` otherwise.
2. Switch the daemon executable and generated systemd unit to the Effect daemon.
3. Switch `/work`, both Pi tools, the CLI, and Topic Agent telemetry to new adapters.
4. Advance the application protocol and ensure stale daemon restart works.
5. Keep old implementation modules unreachable from production entry points.
6. Keep the temporary importer and old source readers only for rollback evidence during the verification window.
7. Restart the user service through the normal manager and run automated smoke tests against the migrated database copy.
8. Update issue 25 to `ready-for-human` after the cutover is committed and checked.

## Constraints

- Do not delete the old implementation in this issue.
- Do not access live data without explicit human permission.
- The new daemon must refuse an absent or unverified migrated database with exact guidance.

## Acceptance

- Static entry-point analysis reaches only the new runtime.
- The full automated suite passes.
- Incompatible old daemon restart works.
- Old code is unreachable but still available for immediate diagnosis until human verification.
- `bun run check` passes.

## Comments
