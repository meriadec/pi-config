# Verify live Work product convergence

Status: done

## Parent

`../PRD.md`

## What to build

Run the final human checkpoint against the complete Effect Work product. Compare the live dashboard and external interfaces with the previous non-Legacy contract, exercise restart and recovery in real Pi and desktop sessions, and record explicit approval or precise remaining gaps.

## Acceptance criteria

- [ ] Every retained row in the convergence audit is marked Present with a test or recorded live observation.
- [ ] Both added dashboard requirements, Cancel Setup and Reset Integration Branch, are Present.
- [ ] A human verifies all dashboard keys, wizards, action-rail actions, focus transitions, list layouts, statuses, confirmations, and narrow/wide rendering.
- [ ] A human restarts `pi-workd` while the dashboard and an existing Main Agent are open and observes clean resubscription and immediate re-attachment without false errors.
- [ ] Root creation, child creation, Recipe failure/retry, Setup cancellation, chain maintenance, rebase, PR opening, terminal, workspace, Main Agent reset, and deletion are exercised on disposable Topics.
- [ ] `allow`, `ask`, and `deny` are verified for every sensitive Action with no unauthorized side effect.
- [ ] Both Pi tools and all Topic, operation, and storage CLI commands pass interactive, headless, JSON, cancellation, and timeout checks.
- [ ] The root harness passes and no runtime, socket, process, watcher, timer, or fiber remains after its owner closes.
- [ ] Legacy name hierarchy behavior remains absent and no old implementation is reintroduced.
- [ ] The issue comments record explicit human approval or exact audit IDs that remain open.

## Blocked by

- `01-restore-topic-agent-registration.md`
- `02-restore-policy-aware-terminal.md`
- `03-restore-policy-aware-main-agent-controls.md`
- `04-restore-policy-aware-topic-deletion.md`
- `05-restore-first-run-configuration.md`
- `06-restore-standard-tui-text-entry.md`
- `07-restore-dashboard-root-topic-creation.md`
- `08-restore-dashboard-child-topic-creation.md`
- `09-restore-retry-setup.md`
- `10-connect-cancel-setup.md`
- `11-restore-integration-status-and-ordering.md`
- `12-restore-parent-topic-actions.md`
- `13-restore-integration-chain-actions.md`
- `14-connect-integration-branch-reset.md`
- `15-restore-pull-request-presentation.md`
- `16-restore-main-agent-presence.md`
- `17-restore-live-dashboard-feedback.md`
- `18-restore-dashboard-navigation.md`
- `19-restore-topic-creation-tools.md`
- `20-restore-topic-creation-cli.md`
- `21-prove-operation-storage-cli.md`

## Comments

- Human approval recorded on 2026-09-16: "I am ok" with the current changes. Future bugs can be handled outside this Ralph Loop; no known audit IDs remain open for this checkpoint.
- Automated verification: `bun run check` passed with 324 tests, strict type checking, lint, and formatting checks.
