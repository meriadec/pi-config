# Pi Configuration

This context captures local Pi agent configuration concepts that are specific to this repository.

## Language

**Grillade**:
A focused Pi extension experience for running a structured grilling interview in a dedicated UI while preserving the interview state in a normal Pi session.
_Avoid_: grill-me UI, grilling wrapper, interview modal

**Grillade Question**:
A structured interview turn with a pinned question, selectable option cards, one recommended default answer, confidence indicators, and a custom-answer path.
_Avoid_: prompt, chat message, question text

**Semantic Grillade State**:
The durable interview state persisted to the Pi session, including active unanswered question, submitted answers, pending documentation proposals, and final actions.
_Avoid_: UI state, draft state, scroll state

**Delegation Job**:
A durable unit of delegated agent work created by the parent Pi session, executed in an isolated child Pi process, and tracked until it produces a compact result for the parent session.
_Avoid_: terminal, subprocess, task

**Delegation Result**:
The compact, parent-visible outcome of a Delegation Job, intended to summarize conclusions and relevant handoff data without exposing the child process's full command outputs or intermediate context.
_Avoid_: logs, transcript, stdout

**Job Mailbox**:
The durable filesystem handoff location owned by a Delegation Job, containing the parent-written request and child-written status/result artifacts used to communicate across separate Pi processes.
_Avoid_: socket, terminal output, session transcript

**Context Packet**:
The explicit, bounded startup information passed from the parent session to a Delegation Job, excluding the full parent conversation unless the user opts into a summary handoff.
_Avoid_: conversation dump, prompt, system prompt
