# Add the durable topic creation wizard

Status: done

## Context

Read the PRD and issues 01-07. The wizard collects intent. The daemon validates and performs all filesystem, GitHub, and `wt` side effects.

## Objective

Let the user add a topic from the dashboard and observe durable provisioning through completion or failure.

## Scope

Wizard interaction:

- Add a discoverable Add action and key hint to the dashboard.
- Collect one field at a time in this order: name, repository, and branch.
- Generate a default branch from the name, but keep it editable after repository entry and before submission.
- Use the standard Pi TUI text input capabilities for each field, including paste and cursor editing.
- Branch defaults must be deterministic, preserve useful ticket identity, remove unsafe branch characters, and never silently submit an empty branch.
- Validate repository as `owner/repo` before submission.
- Show a review step with the exact repository and branch.
- Cancel at any point without creating a topic.

Submission behavior:

- Send one Create Topic request to `workd` with a stable request ID.
- Handle `allow`, `ask`, and `deny` policy responses. For `ask`, show the exact prepared actions and submit the confirmation token only after approval.
- Do not keep the UI blocked while clone or `wt` runs. Return to the dashboard and show live `provisioning` progress.
- Select the new topic when its added event arrives.
- Show `setup-failed` and its bounded reason in details.
- Add Retry Setup for failed or interrupted topics, with the same policy-confirmation behavior.
- Prevent accidental duplicate submissions while a request is in flight.

The wizard must not add topic type. It must not install dependencies.

## Tests

Add tests for:

- Branch defaults for ticket-like names, prose names, punctuation, whitespace, and empty/unsafe input.
- Editing the generated branch.
- Invalid and valid repository references.
- Cancel from every wizard stage.
- Review content.
- Stable request ID across a transport retry.
- `allow`, confirmation, reject, and `deny` flows.
- Non-blocking provisioning updates to ready and setup-failed.
- Retry setup action.
- Duplicate-submit prevention.

Run `bun run check`.

## Acceptance criteria

- A user can create a topic without leaving `/work`.
- The exact branch is passed to daemon provisioning and then to `wt`; the UI never computes a worktree path.
- Long clone/`wt` operations remain visible as live state and do not freeze navigation.
- Failed setup remains durable and retryable.
- The repository harness passes.

## Dependencies

- Issue 07

## Comments
