export interface CodeBlock {
  index: number;
  info: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface CopyCandidate {
  kind: "code" | "full";
  label: string;
  description: string;
  content: string;
}

export function extractSimpleCodeBlocks(text: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let inBlock = false;
  let info = "";
  let contentStart = 0;
  let startLine = 0;
  let lineNumber = 1;
  let lineStart = 0;

  while (lineStart <= text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd);
    const nextLineStart = newlineIndex === -1 ? text.length + 1 : newlineIndex + 1;

    if (!inBlock) {
      if (isOpeningFence(line)) {
        inBlock = true;
        info = line.slice(3).trim();
        contentStart = nextLineStart;
        startLine = lineNumber;
      }
    } else if (line === "```") {
      const contentEnd = text[lineStart - 1] === "\n" ? lineStart - 1 : lineStart;
      blocks.push({
        index: blocks.length + 1,
        info,
        content: text.slice(contentStart, contentEnd),
        startLine,
        endLine: lineNumber,
      });
      inBlock = false;
      info = "";
    }

    if (newlineIndex === -1) break;
    lineStart = nextLineStart;
    lineNumber += 1;
  }

  return blocks;
}

function isOpeningFence(line: string): boolean {
  return line.startsWith("```") && line[3] !== "`";
}

export function countContentLines(content: string): number {
  if (content.length === 0) return 0;
  const lineCount = content.split("\n").length;
  return content.endsWith("\n") ? lineCount - 1 : lineCount;
}

export function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function firstNonEmptyLine(content: string): string {
  return content.split("\n").find((line) => line.length > 0) ?? "";
}

export function buildCodeCandidate(block: CodeBlock): CopyCandidate {
  const language = block.info || "plain";
  const lineCount = countContentLines(block.content);
  const preview = firstNonEmptyLine(block.content);
  return {
    kind: "code",
    label: `#${block.index}  ${language}  ${pluralize(lineCount, "line")}`,
    description: preview,
    content: block.content,
  };
}

export function buildFullAnswerCandidate(text: string): CopyCandidate {
  const lineCount = countContentLines(text);
  const preview = firstNonEmptyLine(text);
  return {
    kind: "full",
    label: `Full answer  ${pluralize(lineCount, "line")}`,
    description: preview,
    content: text,
  };
}
