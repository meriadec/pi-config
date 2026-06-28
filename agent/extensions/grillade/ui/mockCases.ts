import type {
  GrilladeQuestionScreenMode,
  GrilladeQuestionScreenQuestion,
} from "./QuestionScreen.ts";

export type GrilladeMockCase = {
  id: string;
  label: string;
  description: string;
  mode?: GrilladeQuestionScreenMode;
  docsMode?: boolean;
  question: GrilladeQuestionScreenQuestion;
};

const LONG_BODY = [
  "This option intentionally contains a lot of prose so the focused card has to wrap multiple paragraphs without crushing the rest of the screen.",
  "It describes motivations, implementation tradeoffs, possible regressions, keyboard accessibility concerns, terminal-width behavior, and how users might perceive the interaction during a real interview.",
  "The goal is not that every word is visible in a tiny terminal; the goal is that the UI remains calm, bounded, readable, and obviously navigable.",
  "If this text makes the footer disappear, leaks beyond the overlay, or causes the terminal to jitter, the card layout needs another pass.",
].join("\n\n");

const VERY_LONG_CODE_BODY = [
  "This deliberately pathological answer mixes long prose, markdown bullets, fenced code blocks, indentation, URLs, and repeated paragraphs. It exists to reveal whether the choice card remains bounded and legible when the model emits far too much detail for a single answer option.",
  "Things to inspect manually:",
  "- Does the focused card stay inside the fullscreen overlay?",
  "- Does the footer remain reachable or at least not visually corrupt?",
  "- Do code fences wrap without breaking borders?",
  "- Does horizontal overflow from long identifiers get truncated safely?",
  "```ts",
  "type GrilladeQuestionFixture = {",
  "  id: string;",
  "  question: string;",
  "  options: Array<{ id: string; title: string; body: string; confidence: 'low' | 'medium' | 'high' }>;",
  "  recommendedOptionId: string;",
  "};",
  "",
  "export function createAbsurdlyVerboseOption(seed: string): GrilladeQuestionFixture {",
  "  const veryLongIdentifier = 'this_identifier_is_intentionally_extremely_long_to_force_terminal_wrapping_and_truncation_behaviour_checks';",
  "  return {",
  "    id: `fixture-${seed}`,",
  "    question: 'Can the UI survive a pathological option body?',",
  "    options: [{ id: 'yes', title: veryLongIdentifier, body: seed.repeat(100), confidence: 'high' }],",
  "    recommendedOptionId: 'yes',",
  "  };",
  "}",
  "```",
  "Here is another paragraph after the TypeScript block. It should not inherit code styling because the renderer currently treats bodies as plain wrapped text, not markdown. That is okay for now, but the raw fence characters should still be visually tolerable.",
  "```bash",
  "for width in 40 60 80 120; do",
  "  bun test agent/extensions/grillade/ui/QuestionScreen.test.ts --width=$width",
  "done",
  "```",
  "A final long line follows: https://example.com/some/really/deep/path/with/many/segments/and-query-params?alpha=one&beta=two&gamma=three&delta=four&epsilon=five#fragment-that-keeps-going",
  LONG_BODY,
  LONG_BODY,
].join("\n\n");

export const GRILLADE_MOCK_CASES: readonly GrilladeMockCase[] = [
  {
    id: "basic-2-options",
    label: "Basic two options",
    description: "Small happy-path fixture with two authored choices.",
    docsMode: true,
    question: {
      questionId: "mock-basic-2-options",
      phase: "questioning",
      question: "Which fullscreen treatment should the Grillade question UI use?",
      context: "A simple smoke test for the default question layout.",
      options: [
        {
          id: "overlay",
          title: "Fullscreen overlay",
          body: "Use a dedicated fullscreen overlay so the interview feels like a focused mode.",
          confidence: "high",
        },
        {
          id: "inline",
          title: "Inline replacement",
          body: "Keep the question near the editor with less screen takeover.",
          confidence: "low",
        },
      ],
      recommendedOptionId: "overlay",
      allowCustomAnswer: true,
      progress: { answered: 0, totalHint: 4 },
    },
  },
  {
    id: "basic-3-options",
    label: "Basic three options",
    description: "Verifies the full up-to-three authored choice strip.",
    question: {
      questionId: "mock-basic-3-options",
      phase: "questioning",
      question: "How should custom answers be exposed?",
      options: [
        {
          id: "shortcut",
          title: "Shortcut only",
          body: "Show custom answer as a persistent C shortcut in the footer and choice strip.",
          confidence: "medium",
        },
        {
          id: "separate-screen",
          title: "Separate custom screen",
          body: "Treat custom answer as a first-class alternate screen with explanatory copy and a text input.",
          confidence: "high",
        },
        {
          id: "inline-field",
          title: "Always-visible field",
          body: "Show the custom answer text field below every choice card.",
          confidence: "low",
        },
      ],
      recommendedOptionId: "separate-screen",
      allowCustomAnswer: true,
      progress: { answered: 1, totalHint: 4 },
    },
  },
  {
    id: "long-choice",
    label: "Long choice body",
    description: "One option has a very long body with paragraph breaks.",
    question: {
      questionId: "mock-long-choice",
      phase: "questioning",
      question: "What happens when one suggested answer has a lot of explanatory text?",
      context:
        "Use left/right to compare short and very long options. Resize the terminal while this is open.",
      options: [
        {
          id: "short",
          title: "Short option",
          body: "This deliberately tiny option makes contrast obvious.",
          confidence: "medium",
        },
        {
          id: "verbose",
          title: "Verbose option with extensive rationale",
          body: LONG_BODY,
          confidence: "high",
        },
        {
          id: "balanced",
          title: "Balanced option",
          body: "Keep enough detail for informed selection, but avoid writing a mini design doc inside one card.",
          confidence: "medium",
        },
      ],
      recommendedOptionId: "verbose",
      allowCustomAnswer: true,
      progress: { answered: 2, totalHint: 5 },
    },
  },
  {
    id: "very-long-code-answer",
    label: "Very long answer with code blocks",
    description:
      "Pathological option body with markdown fences, long URLs, repeated prose, and code.",
    question: {
      questionId: "mock-very-long-code-answer",
      phase: "questioning",
      question: "Can one extremely verbose answer body with code blocks stay bounded and usable?",
      context:
        "This intentionally violates the desired answer length so we can inspect clipping, wrapping, and footer behavior.",
      options: [
        {
          id: "short",
          title: "Short control",
          body: "A short control option for contrast.",
          confidence: "medium",
        },
        {
          id: "huge-code",
          title: "Very long answer with code blocks, URLs, bullets, and repeated paragraphs",
          body: VERY_LONG_CODE_BODY,
          confidence: "high",
        },
        {
          id: "medium",
          title: "Medium fallback",
          body: "A realistic medium-size option that should still feel pleasant after viewing the pathological one.",
          confidence: "medium",
        },
      ],
      recommendedOptionId: "huge-code",
      allowCustomAnswer: true,
      progress: { answered: 4, totalHint: 7 },
    },
  },
  {
    id: "long-question",
    label: "Long question/context/constraints",
    description: "Stress-tests wrapping above the choice card.",
    question: {
      questionId: "mock-long-question",
      phase: "opening",
      question:
        "When the prompt itself is unusually verbose and asks about multiple design dimensions at once, can Grillade still present the actual decision clearly without making the choices feel pushed below the fold?",
      context:
        "This context is intentionally long. It mentions entry transitions, fullscreen behavior, keyboard affordances, custom answer handling, recommender emphasis, terminal resize behavior, and the need to avoid leaking ordinary chat content behind the interview surface.",
      constraints: [
        "The question UI should feel like a deliberate mode, not a pasted form.",
        "The user must be able to select a suggested answer quickly with the keyboard.",
        "Custom steering must remain available without competing visually with authored choices.",
        "The layout should remain bounded in narrow terminals and with verbose copy.",
      ],
      options: [
        {
          id: "compress",
          title: "Compress metadata",
          body: "Keep context and constraints visible, but make their styling quiet so the question and current choice remain dominant.",
          confidence: "high",
        },
        {
          id: "hide",
          title: "Hide secondary text",
          body: "Only show the question and choices by default, hiding context behind a keybinding or disclosure state.",
          confidence: "medium",
        },
      ],
      recommendedOptionId: "compress",
      allowCustomAnswer: true,
      progress: { answered: 0, maxHint: 3 },
    },
  },
  {
    id: "long-titles",
    label: "Long option titles",
    description: "Choice strip truncation with oversized labels.",
    question: {
      questionId: "mock-long-titles",
      phase: "questioning",
      question: "Can the choice strip stay readable when titles are too long?",
      options: [
        {
          id: "first",
          title:
            "A very long title that should be truncated in the strip but still readable in the card",
          body: "The card header should preserve the title better than the compact strip can.",
          confidence: "medium",
        },
        {
          id: "second",
          title: "Another extremely long title with punctuation, clauses, and extra qualifiers",
          body: "This verifies that multiple long titles do not blow past the terminal width.",
          confidence: "high",
        },
        {
          id: "third",
          title: "Short fallback",
          body: "A normal title next to pathological ones.",
          confidence: "low",
        },
      ],
      recommendedOptionId: "second",
      allowCustomAnswer: true,
      progress: { answered: 3, totalHint: 6 },
    },
  },
  {
    id: "five-choices",
    label: "Five choices stress case",
    description: "QA-only fixture beyond the production 2–3 option contract.",
    question: {
      questionId: "mock-five-choices",
      phase: "questioning",
      question: "How does the carousel and choice strip behave with five choices?",
      context:
        "Production Grillade questions should use 2–3 authored choices. This fixture is intentionally out-of-contract to stress the renderer.",
      options: [
        {
          id: "one",
          title: "First choice",
          body: "Navigate right to inspect each extra choice.",
          confidence: "medium",
        },
        {
          id: "two",
          title: "Second choice with a slightly longer label",
          body: "This checks whether the compact strip remains bounded with more than three entries.",
          confidence: "medium",
        },
        {
          id: "three",
          title: "Third recommended choice",
          body: "This is recommended and should be selected initially even though there are five total choices.",
          confidence: "high",
        },
        {
          id: "four",
          title: "Fourth choice",
          body: "This choice exists to verify number shortcuts and right-arrow navigation past the recommended option.",
          confidence: "low",
        },
        {
          id: "five",
          title: "Fifth choice before custom",
          body: "Press right once more from here to enter custom answer mode.",
          confidence: "low",
        },
      ],
      recommendedOptionId: "three",
      allowCustomAnswer: true,
      progress: { answered: 5, totalHint: 8 },
    },
  },
  {
    id: "recommended-first",
    label: "Recommended first",
    description: "Initial selection and badge when recommendation is first.",
    question: {
      questionId: "mock-recommended-first",
      phase: "questioning",
      question: "Does the carousel start on the recommended option when it is first?",
      options: [
        {
          id: "first",
          title: "Recommended first",
          body: "This should be selected initially and show the recommended emphasis.",
          confidence: "high",
        },
        {
          id: "second",
          title: "Second option",
          body: "Navigate right to reach this one.",
          confidence: "medium",
        },
      ],
      recommendedOptionId: "first",
      allowCustomAnswer: true,
    },
  },
  {
    id: "recommended-last",
    label: "Recommended last",
    description: "Initial selection and badge when recommendation is last.",
    question: {
      questionId: "mock-recommended-last",
      phase: "questioning",
      question: "Does the carousel start on the recommended option when it is last?",
      options: [
        {
          id: "first",
          title: "First option",
          body: "This should be accessible by navigating left from the initial selection.",
          confidence: "medium",
        },
        {
          id: "last",
          title: "Recommended last",
          body: "This should be selected initially and show the recommended emphasis.",
          confidence: "high",
        },
      ],
      recommendedOptionId: "last",
      allowCustomAnswer: true,
    },
  },
  {
    id: "no-custom",
    label: "No custom answer",
    description: "Custom answer affordances should disappear.",
    question: {
      questionId: "mock-no-custom",
      phase: "questioning",
      question: "What does the UI look like when custom answers are disabled?",
      options: [
        {
          id: "strict-a",
          title: "Strict option A",
          body: "The footer and choice strip should not advertise C custom.",
          confidence: "medium",
        },
        {
          id: "strict-b",
          title: "Strict option B",
          body: "Tab/C should not move into a custom input state.",
          confidence: "high",
        },
      ],
      recommendedOptionId: "strict-b",
      allowCustomAnswer: false,
    },
  },
  {
    id: "unicode-wide",
    label: "Unicode and wide characters",
    description: "Emoji, CJK, accents, arrows, and box-width edge cases.",
    question: {
      questionId: "mock-unicode-wide",
      phase: "questioning",
      question:
        "Can the renderer handle wide text like 日本語, français, emojis 🚀🔥, and arrows ← → without width bugs?",
      context: "Try resizing the terminal narrowly; every line should stay within bounds.",
      options: [
        {
          id: "unicode-a",
          title: "Emoji-heavy 🚀 choice",
          body: "Use visual markers like ✅, ⚠️, and ✨ while preserving alignment across terminal emulators.",
          confidence: "medium",
        },
        {
          id: "unicode-b",
          title: "CJK 日本語 option",
          body: "日本語の文章とEnglish textを混ぜても、折り返しと罫線が壊れないことを確認します。",
          confidence: "high",
        },
        {
          id: "unicode-c",
          title: "Accents déjà vu",
          body: "Café, naïve, résumé, coöperate, and other accented text should render normally.",
          confidence: "medium",
        },
      ],
      recommendedOptionId: "unicode-b",
      allowCustomAnswer: true,
    },
  },
  {
    id: "active-work-cancel",
    label: "Active-work cancel overlay",
    description: "Esc should show the active work cancellation confirmation.",
    mode: "active-work",
    question: {
      questionId: "mock-active-work-cancel",
      phase: "questioning",
      question: "When active work is waiting on the answer, does Esc ask before cancelling?",
      context: "Press Esc to inspect the confirmation overlay; y cancels, n/Esc returns.",
      options: [
        {
          id: "continue",
          title: "Keep working",
          body: "Answering this option simulates continuing the active Grillade work.",
          confidence: "high",
        },
        {
          id: "pause",
          title: "Pause manually",
          body: "Use Esc to exercise the cancellation confirmation instead of selecting this option.",
          confidence: "low",
        },
      ],
      recommendedOptionId: "continue",
      allowCustomAnswer: true,
    },
  },
];

export function getGrilladeMockCase(id: string): GrilladeMockCase | undefined {
  return GRILLADE_MOCK_CASES.find((mockCase) => mockCase.id === id);
}
