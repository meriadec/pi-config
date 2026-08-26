# 05 — Add the `work_topic_create` Pi tool

Status: done
Type: feature
Blocked by: 03
Affected extension: `work`

## Context

A skill cannot provide typed Topic creation or enforce daemon policy. The `work` extension must register an LLM-callable tool that the model can select from requests such as “Create a work Topic from HEAD~2 named My contribution.”

The tool runs in TUI and non-TUI Pi modes. An `ask` Action policy needs direct human approval and cannot be approved by the model that called the tool.

## Scope

- Register one focused tool named `work_topic_create` from the existing `work` extension entry.
- Define typed parameters for required `name` and optional `repository`, `branch`, `startPoint`, and `sourceCheckout`.
- Add a direct description, prompt snippet, and guidelines with the two agreed natural-language cases. State that the tool creates and provisions a Topic but does not open its Main Agent.
- Default Source checkout to `ctx.cwd` and use the shared resolver from issue 01.
- Connect through the existing systemd manager and call the same WorkClient operation as the dashboard and CLI.
- Wait for the terminal provisioning result. Use `onUpdate` for bounded semantic progress such as clone, Worktree creation, and `setup N/M`; do not expose raw daemon or Setup command output.
- For each `ask` result:
  - when `ctx.hasUI`, show the daemon's exact confirmation text in a direct user dialog and submit confirm or reject from that answer;
  - without UI, return confirmation-required and do not approve it.
- Ensure the tool description never tells the model to treat the original natural-language request as confirmation.
- Return structured details plus concise text with Topic ID, repository, Branch, setup state, and Worktree path.
- Forward cancellation to local waiting and close the WorkClient safely.
- Do not add a dedicated skill or open a Main Agent.

## Acceptance criteria

- [ ] Pi registers `work_topic_create` once, including after extension reload behavior covered by the existing registration pattern.
- [ ] Tool parameters omit repository and Branch successfully when `ctx.cwd` supplies them.
- [ ] The model-facing description includes clear creation triggers and exact parameter meaning without a separate skill.
- [ ] `ask` always reaches a direct user dialog in UI mode; the model cannot set an approval parameter.
- [ ] Headless execution returns confirmation-required without calling `confirm`.
- [ ] `deny`, Branch conflict, repository mismatch, resolution failure, cancellation, and daemon disconnect produce bounded tool results.
- [ ] Progress updates contain semantic phases only and remain bounded.
- [ ] Success returns the ready Topic and does not invoke desktop or Main Agent actions.
- [ ] Tests use fake UI, resolver, and WorkClient seams without a real model or systemd service.
- [ ] `bun run check` passes.

## Validation

- Extension registration and schema tests.
- Tool execution tests for inferred and explicit inputs.
- UI and headless policy-confirmation tests.
- Progress, cancellation, and result-rendering tests.
- Full harness.

## Comments
