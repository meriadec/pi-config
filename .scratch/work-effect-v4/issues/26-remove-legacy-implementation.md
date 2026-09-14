# Remove the legacy Work implementation

Status: needs-info

Depends on: 25 human approval

Suggested commit: `refactor(work): remove legacy control plane`

## Read first

- `../PRD.md`, especially Final removal and Completion
- issue 25 Comments
- ADR-0006

## Objective

Delete every obsolete Work implementation after the human verifies the live Effect cutover.

## Scope

1. Verify explicit human approval in issue 25. Stop with `needs_human` otherwise.
2. Delete old JSON Topic, affiliation, and migration stores, then remove obsolete raw affiliation files after approval.
3. Delete the temporary JSON-to-SQLite importer and its production command.
4. Delete the custom NDJSON protocol, decoder, server dispatch, and Promise socket client.
5. Delete Promise lock queues, timer-owned lifecycle classes, old process runner, and obsolete adapters.
6. Delete Legacy name hierarchy detection, preview, migration, rendering, UI actions, protocol calls, docs, and tests.
7. Delete temporary compatibility adapters and feature switches.
8. Remove tests that inspect deleted implementation details after equivalent deep-interface tests exist.
9. Keep pure domain modules only when the final application uses them.
10. Update architecture checks to reject imports of deleted paths and unmanaged capabilities.
11. Confirm old live JSON paths are ignored and the original private backup remains untouched.

## Acceptance

- Search finds no production reference to old Topic manifests, affiliations JSON, migration journals, Legacy hierarchy, old protocol versions, old socket client, or old process runner.
- No production entry can select the old system.
- New deep-interface tests cover retained behavior.
- Repository and domain documentation describe only the final model.
- `bun run check` passes.

## Comments
