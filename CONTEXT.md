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
