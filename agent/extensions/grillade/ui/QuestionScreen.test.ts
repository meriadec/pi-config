import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { QuestionScreen } from "./QuestionScreen.ts";
import { GRILLADE_MOCK_CASES } from "./mockCases.ts";

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

describe("QuestionScreen mock fixtures", () => {
  for (const mockCase of GRILLADE_MOCK_CASES) {
    test(`${mockCase.id} renders within width`, () => {
      for (const width of [40, 60, 80, 120]) {
        const screen = new QuestionScreen(mockCase.question, plainTheme, () => {}, {
          ...(mockCase.mode !== undefined ? { mode: mockCase.mode } : {}),
          ...(mockCase.docsMode !== undefined ? { docsMode: mockCase.docsMode } : {}),
        });

        const lines = screen.render(width);

        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    });
  }

  test("custom-disabled fixture hides custom affordances", () => {
    const mockCase = GRILLADE_MOCK_CASES.find((fixture) => fixture.id === "no-custom");
    expect(mockCase).toBeDefined();
    const screen = new QuestionScreen(mockCase!.question, plainTheme, () => {});

    const text = screen.render(80).join("\n");

    expect(text).not.toContain("C Custom");
    expect(text).not.toContain("C custom");
    expect(text).not.toContain("Custom answer is available");
  });

  test("recommended emphasis is visible for fixtures", () => {
    for (const mockCase of GRILLADE_MOCK_CASES) {
      const screen = new QuestionScreen(mockCase.question, plainTheme, () => {});

      const text = screen.render(120).join("\n");

      expect(text).toContain("★");
    }
  });

  test("right navigation reaches custom answer after the last choice", () => {
    const mockCase = GRILLADE_MOCK_CASES.find((fixture) => fixture.id === "basic-3-options");
    expect(mockCase).toBeDefined();
    const screen = new QuestionScreen(mockCase!.question, plainTheme, () => {});

    screen.handleInput("\x1b[C");
    screen.handleInput("\x1b[C");

    const text = screen.render(100).join("\n");
    expect(text).toContain("Custom answer / steering");
    expect(text).toContain(" C Custom ");
  });

  test("custom answer input does not render a doubled prompt", () => {
    const mockCase = GRILLADE_MOCK_CASES.find((fixture) => fixture.id === "basic-3-options");
    expect(mockCase).toBeDefined();
    const screen = new QuestionScreen(mockCase!.question, plainTheme, () => {});

    screen.handleInput("c");

    const text = screen.render(100).join("\n");
    expect(text).not.toContain("> >");
  });

  test("up and down scroll the focused answer instead of changing choices", () => {
    const mockCase = GRILLADE_MOCK_CASES.find((fixture) => fixture.id === "very-long-code-answer");
    expect(mockCase).toBeDefined();
    const screen = new QuestionScreen(mockCase!.question, plainTheme, () => {});

    const initial = screen.render(100).join("\n");
    expect(initial).toContain("Option 2 of 3");
    expect(initial).toContain("Body  ▼ lines 1");

    screen.handleInput("\x1b[B");
    const afterDown = screen.render(100).join("\n");
    expect(afterDown).toContain("Option 2 of 3");
    expect(afterDown).toContain("Body ▲▼ lines 2");

    screen.handleInput("\x1b[A");
    const afterUp = screen.render(100).join("\n");
    expect(afterUp).toContain("Option 2 of 3");
    expect(afterUp).toContain("Body  ▼ lines 1");
  });

  test("focused answer viewport expands with available terminal height", () => {
    const mockCase = GRILLADE_MOCK_CASES.find((fixture) => fixture.id === "very-long-code-answer");
    expect(mockCase).toBeDefined();
    const screen = new QuestionScreen(mockCase!.question, plainTheme, () => {}, {
      getViewportHeight: () => 50,
    });

    const text = screen.render(100).join("\n");
    const match = text.match(/Body  ▼ lines 1–(\d+)\//);

    expect(match).toBeDefined();
    expect(Number(match![1])).toBeGreaterThan(14);
  });
});
