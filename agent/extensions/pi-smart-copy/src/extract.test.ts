import { describe, expect, test } from "bun:test";
import {
  buildFullAnswerCandidate,
  countContentLines,
  extractSimpleCodeBlocks,
} from "./extract.ts";

describe("extractSimpleCodeBlocks", () => {
  test("returns no blocks when none are present", () => {
    expect(extractSimpleCodeBlocks("hello\nworld\n")).toEqual([]);
  });

  test("extracts one block without the delimiter newline before the closing fence", () => {
    const blocks = extractSimpleCodeBlocks("```bash\necho hi\n```\n");

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      index: 1,
      info: "bash",
      content: "echo hi",
      startLine: 1,
      endLine: 3,
    });
  });

  test("extracts multiple blocks and preserves raw content", () => {
    const text = [
      "intro",
      "```ts",
      "const x = 1;",
      "",
      "console.log(x);",
      "```",
      "middle",
      "```",
      "  leading spaces stay",
      "trailing spaces stay   ",
      "```",
      "outro",
    ].join("\n");

    const blocks = extractSimpleCodeBlocks(text);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.info).toBe("ts");
    expect(blocks[0]?.content).toBe("const x = 1;\n\nconsole.log(x);");
    expect(blocks[1]?.info).toBe("");
    expect(blocks[1]?.content).toBe("  leading spaces stay\ntrailing spaces stay   ");
  });

  test("ignores indented fences", () => {
    const blocks = extractSimpleCodeBlocks("  ```bash\necho hi\n  ```\n");

    expect(blocks).toEqual([]);
  });

  test("ignores unclosed blocks", () => {
    const blocks = extractSimpleCodeBlocks("before\n```bash\necho hi\n");

    expect(blocks).toEqual([]);
  });

  test("ignores longer opening fences", () => {
    const blocks = extractSimpleCodeBlocks("````bash\necho hi\n```\n");

    expect(blocks).toEqual([]);
  });

  test("requires closing fence to be exactly three backticks at column zero", () => {
    const text = "```bash\necho hi\n```   \nstill in block\n```\n";
    const blocks = extractSimpleCodeBlocks(text);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.content).toBe("echo hi\n```   \nstill in block");
  });
});

describe("copy helpers", () => {
  test("countContentLines ignores only the terminal newline for display counts", () => {
    expect(countContentLines("")).toBe(0);
    expect(countContentLines("one")).toBe(1);
    expect(countContentLines("one\n")).toBe(1);
    expect(countContentLines("one\n\n")).toBe(2);
  });

  test("full answer fallback keeps raw assistant text", () => {
    const raw = "  hello\nworld   \n";

    expect(buildFullAnswerCandidate(raw).content).toBe(raw);
  });
});
