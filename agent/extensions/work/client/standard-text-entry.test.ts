import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { StandardTextEntry } from "./standard-text-entry.ts";

describe("standard TUI text entry", () => {
  test("supports cursor movement, insertion, backward deletion, and forward deletion", () => {
    const entry = new StandardTextEntry({ initialValue: "Alxpha" });

    entry.handleInput("\x1b[H");
    entry.handleInput("\x1b[C");
    entry.handleInput("\x1b[C");
    entry.handleInput("\x1b[3~");
    entry.handleInput("\x1b[F");
    entry.handleInput("x");
    entry.handleInput("\x7f");

    expect(entry.getValue()).toBe("Alpha");
  });

  test("uses bracketed paste and normalizes Note line breaks to spaces", () => {
    const entry = new StandardTextEntry({ lineBreaks: "space" });

    entry.handleInput("\x1b[200~waiting\r\nfor\u2028Tom\x1b[201~");

    expect(entry.getValue()).toBe("waiting for Tom");
    expect(entry.render(40)).toHaveLength(1);
  });

  test("follows focus and releases it when disposed", () => {
    const entry = new StandardTextEntry({ initialValue: "Alpha" });
    entry.focused = true;
    expect(entry.render(40)[0]).toContain(CURSOR_MARKER);

    entry.dispose();
    entry.handleInput("x");

    expect(entry.focused).toBeFalse();
    expect(entry.render(40)[0]).not.toContain(CURSOR_MARKER);
    expect(entry.getValue()).toBe("Alpha");
  });
});
