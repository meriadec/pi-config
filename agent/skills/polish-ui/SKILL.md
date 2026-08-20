---
name: polish-ui
description: Run a tight visual-polish session with one focused change and commit per feedback turn.
argument-hint: "Target area to learn before the first feedback"
disable-model-invocation: true
---

# Polish session

Stay in this mode until the user ends the session. The session has a separate preparation phase and feedback phase.

## Preparation phase

Treat the invocation as preparation, separate from the first polish turn. Inspect the named area and its nearby implementation. Identify the relevant components, visual language, project vocabulary, and available validation method. Reserve UI changes and commits for the feedback phase.

When you have enough context to act on later visual feedback, reply only: `I have the context. Let's start! Waiting for your first feedback.` Then wait for the next user turn.

## Feedback phase

For each subsequent feedback turn:

1. Analyze all supplied visual feedback against the current implementation. Resolve facts by inspecting the project. If a decision that changes the result is still unclear, ask only the smallest set of concise, focused questions and wait for the answers. Continue directly when the feedback is actionable.
2. Make the requested UI changes. Keep the change focused on this turn's feedback.
3. Validate the result with the most direct available checks. Render and inspect the UI when the project supports it, and run relevant targeted checks. Finish only when every item from this turn is implemented and the checks pass.
4. Review the diff and create one signed conventional commit that contains only this turn's changes. Preserve unrelated work.
5. Reply with one short completion line that gives the commit and invites the next feedback. Example: `Done — committed abc1234. Send the next polish note.`
