# Verify the live Effect cutover

Status: done

Depends on: 24

## Purpose

Verify the new daemon and clients against the migrated real data before an agent removes the old implementation and importer.

## Human procedure

1. Confirm issue 24 is complete and change this issue to `ready-for-human`.
2. Reload Pi and open `/work`.
3. Verify Topic count, hierarchy, Integration Chain order, Partitions, Notes, setup state, Integration Status, pull requests, and Main Agent identities.
4. Exercise representative safe behavior:
   - refresh observations
   - reconnect the dashboard
   - focus a Topic workspace
   - open or reattach one Main Agent
   - create a disposable test Topic when acceptable
   - verify an Operation Handle through the CLI
5. Restart `pi-workd` and verify state, operation query, Main Agent reattachment, and dashboard resubscription.
6. Inspect bounded structured logs for unexpected defects, raw capabilities, Setup commands, or excessive output.
7. Run `pi-work storage verify` again.
8. Append the non-secret verification result and explicit approval under Comments.

## Failure rule

If any result differs from the approved migration receipt or expected behavior, stop. Keep the old implementation and importer. Record the symptom and request an agent diagnosis.

## Completion

After explicit approval, change issue 26 from `needs-info` to `ready-for-agent`.

## Comments

- Live verification failed before data checks: the refactoring is still only on its branch. Opening `/work` in the currently running Pi reports `unsupported configuration version`. No cutover approval was given. Keep the old implementation and importer, and diagnose the version mismatch before retrying this procedure.
- The human declined to perform the live verification. The cutover is not approved. Do not remove the old implementation or importer, and do not make issue 26 ready for an agent.
- The human later gave explicit approval of the live Effect cutover and asked the agent to remove the old implementation and importer.
