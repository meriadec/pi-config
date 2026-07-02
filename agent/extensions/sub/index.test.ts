import { describe, expect, test } from "bun:test";
import { SUB_CUSTOM_RESULT } from "./mailbox.ts";
import { removeAnsweredDelegationResults, truncateResultForContext } from "./index.ts";
import { buildParentFollowUp } from "./prompts.ts";

type TestMessage = {
  role: string;
  customType?: string;
  content?: unknown;
};

const delegationResult: TestMessage = {
  role: "custom",
  customType: SUB_CUSTOM_RESULT,
  content: buildParentFollowUp("job-123", "Reviewed the parser and found no blockers."),
};

const assistantReply: TestMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Got it." }],
};

describe("sub delegation result truncation", () => {
  test("keeps under-cap delegation results unchanged", () => {
    const result = "Short delegation result with exact config details.";

    expect(truncateResultForContext(result, "/tmp/sub/job/result.md")).toBe(result);
  });

  test("preserves head and tail with metadata when over cap", () => {
    const result = `HEAD:${"a".repeat(120 * 1024)}MIDDLE:${"b".repeat(120 * 1024)}:TAIL`;
    const truncated = truncateResultForContext(result, "/tmp/sub/job/result.md");

    expect(truncated.length).toBeLessThan(result.length);
    expect(truncated).toContain("HEAD:");
    expect(truncated).toContain(":TAIL");
    expect(truncated).toContain("Delegation Result truncated for parent context");
    expect(truncated).toContain("Full result: /tmp/sub/job/result.md");
  });
});

describe("sub delegation result context cleanup", () => {
  test("keeps hidden custom delegation result until the main assistant answers", () => {
    const messages = [delegationResult];

    expect(removeAnsweredDelegationResults(messages)).toEqual(messages);
  });

  test("removes hidden custom delegation result after the main assistant answers", () => {
    const messages = [delegationResult, assistantReply];

    expect(removeAnsweredDelegationResults(messages)).toEqual([assistantReply]);
  });

  test("continues removing legacy visible user delegation results after answer", () => {
    const legacyResult: TestMessage = {
      role: "user",
      content: buildParentFollowUp("job-123", "Reviewed the parser and found no blockers."),
    };

    expect(removeAnsweredDelegationResults([legacyResult, assistantReply])).toEqual([
      assistantReply,
    ]);
  });

  test("keeps unrelated custom messages", () => {
    const unrelated: TestMessage = {
      role: "custom",
      customType: "other-extension",
      content: buildParentFollowUp("job-123", "Reviewed the parser and found no blockers."),
    };

    expect(removeAnsweredDelegationResults([unrelated, assistantReply])).toEqual([
      unrelated,
      assistantReply,
    ]);
  });
});
