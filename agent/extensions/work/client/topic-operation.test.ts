import { describe, expect, test } from "bun:test";
import { AbsolutePath, ClientId, RequestId } from "../domain/index.ts";
import type { WorkConfiguration } from "../infrastructure/config.ts";
import { planRootTopicOperation } from "./topic-operation.ts";

const configuration: WorkConfiguration = {
  version: 2,
  workBase: AbsolutePath.make("/work"),
  policies: {
    defaults: {
      "repository.clone": "ask",
      "topic.create-worktree": "allow",
      "topic.run-setup": "allow",
      "terminal.open": "allow",
      "agent.open": "allow",
      "agent.reset": "ask",
      "topic.delete": "ask",
    },
    repositories: {},
    topics: {},
  },
  repositories: {},
};

describe("Effect Topic operation planning", () => {
  test("an explicit repository without a Start Point does not inspect a Source checkout", async () => {
    const plan = await planRootTopicOperation(
      { name: "Explicit topic", repository: "acme/widgets" },
      configuration,
      ClientId.make("10000000-0000-4000-8000-000000000001"),
      RequestId.make("20000000-0000-4000-8000-000000000001"),
    );
    expect(String(plan.repository)).toBe("acme/widgets");
    expect(String(plan.branch)).toBe("explicit-topic");
    expect(String(plan.request.requestId)).toBe("20000000-0000-4000-8000-000000000001");
    expect(plan.request.input.kind).toBe("topic.provision");
    expect(plan.request.input.value).toMatchObject({
      attempt: "create-root",
      workBase: "/work",
      recipe: { setupCommands: [] },
    });
  });
});
