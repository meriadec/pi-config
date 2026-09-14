# Verify the live Effect cutover

Status: needs-info

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
