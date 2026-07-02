import { describe, expect, test } from "bun:test";
import {
  buildChildCompletionMessage,
  buildChildSystemPrompt,
  buildParentFollowUp,
} from "./prompts.ts";

describe("sub delegation prompts", () => {
  test("parent follow-up asks for a summary and human approval before action", () => {
    const prompt = buildParentFollowUp(
      "job-123",
      "Recommend changing agent/extensions/sub/prompts.ts",
    );

    expect(prompt).toContain("Sub-agent Delegation Job job-123 completed.");
    expect(prompt).toContain("Recommend changing agent/extensions/sub/prompts.ts");
    expect(prompt).toContain("summarize this Delegation Result");
    expect(prompt).toContain("raise human-in-the-loop");
    expect(prompt).toContain("asking how they want to proceed");
    expect(prompt).toContain("Do not implement recommended fixes");
    expect(prompt).toContain("unless the human explicitly approves");
  });

  test("child prompt makes sub_done the terminal child action", () => {
    const prompt = buildChildSystemPrompt("job-123", "/tmp/sub/job-123");

    expect(prompt).toContain("Treat `sub_done` as your final action");
    expect(prompt).toContain("do not write a separate final answer, recap, or summary");
    expect(prompt).toContain("The parent session will import only that Delegation Result");
  });

  test("child completion message discourages an extra child summary", () => {
    const message = buildChildCompletionMessage("job-123", "Done: fixed the issue.");

    expect(message).toContain("Delegation Result written for job-123.");
    expect(message).toContain("Stop now; do not add a separate summary");
    expect(message).toContain("Done: fixed the issue.");
  });
});
