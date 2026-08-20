---
name: polish-ui
description: Run a tight visual-polish session with one focused change and commit per feedback turn.
argument-hint: "Target area and optional first visual feedback"
disable-model-invocation: true
---

# Polish session

Stay in this mode until the user ends the session. Use one tight loop for each feedback turn, including feedback supplied at invocation.

At invocation, inspect the named area and its nearby implementation. Identify the relevant components, visual language, and project vocabulary before you process the feedback.

For each turn:

1. Analyze all supplied visual feedback against the current implementation. Resolve facts by inspecting the project. If a decision that changes the result is still unclear, ask only the smallest set of concise, focused questions and wait for the answers. Continue directly when the feedback is actionable.
2. Make the requested UI changes. Keep the change focused on this turn's feedback.
3. Validate the result with the most direct available checks. Render and inspect the UI when the project supports it, and run relevant targeted checks. Finish only when every item from this turn is implemented and the checks pass.
4. Review the diff and create one signed conventional commit that contains only this turn's changes. Preserve unrelated work.
5. Reply with one short completion line that gives the commit and invites the next feedback. Example: `Done — committed abc1234. Send the next polish note.`
