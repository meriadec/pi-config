import { describe, expect, test } from "bun:test";
import {
  INTEGRATION_BRANCH_NODE,
  planChainMove,
  planChangeParent,
  planChildActivation,
  displayChildOrder,
  planChildInsertion,
  planIntegrationTargetReset,
  planRemoveParent,
  planTopicDeletion,
  resolveFamily,
  topicNode,
  validateTopicGraph,
} from "./index.ts";
import type { AncestryLookup, ChainNode, ChainTopic } from "./index.ts";

const PARENT = "123e4567-e89b-42d3-a456-426614174000";
const B = "123e4567-e89b-42d3-a456-426614174001";
const C = "123e4567-e89b-42d3-a456-426614174002";
const D = "123e4567-e89b-42d3-a456-426614174003";
const OTHER = "123e4567-e89b-42d3-a456-426614174004";

/**
 * Ancestry from declared linear tips: a Topic contains every Branch that appears earlier
 * in the list. The Integration Branch is always position 0.
 */
function linearAncestry(order: readonly string[]): AncestryLookup {
  const position = (node: ChainNode): number | undefined =>
    node.kind === "integration-branch" ? 0 : indexOrUndefined(order, node.topicId);
  return (ancestor, descendant) => {
    const left = position(ancestor);
    const right = position(descendant);
    if (left === undefined || right === undefined) return undefined;
    return left <= right;
  };
}

function indexOrUndefined(order: readonly string[], topicId: string): number | undefined {
  const found = order.indexOf(topicId);
  return found < 0 ? undefined : found + 1;
}

function topic(id: string, overrides: Partial<ChainTopic> = {}): ChainTopic {
  return { id, repository: "acme/app", ...overrides };
}

/** `main ← B ← C ← parent`. */
function chainMainBCParent(): ChainTopic[] {
  return [
    topic(PARENT, { integrationTarget: topicNode(C) }),
    topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
    topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
  ];
}

describe("integration chain validation", () => {
  test("accepts main <- B <- C <- parent", () => {
    const topics = chainMainBCParent();
    expect(validateTopicGraph(topics)).toBeUndefined();
    const family = resolveFamily(topics, PARENT);
    expect(family.ok).toBe(true);
    if (!family.ok) return;
    expect(family.value.children.map((child) => child.id)).toEqual([B, C]);
  });

  test("accepts a family with no children", () => {
    const topics = [topic(PARENT, { integrationTarget: INTEGRATION_BRANCH_NODE })];
    expect(validateTopicGraph(topics)).toBeUndefined();
  });

  test("rejects a nested child", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(B) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(C, { parentTopicId: B, integrationTarget: topicNode(B) }),
    ];
    expect(validateTopicGraph(topics)?.code).toBe("nested-child");
  });

  test("rejects a cross-repository child", () => {
    const topics = chainMainBCParent();
    topics[1] = { ...topic(B), repository: "acme/other", parentTopicId: PARENT };
    expect(validateTopicGraph(topics)?.code).toBe("cross-repository");
  });

  test("rejects a missing Parent Topic reference", () => {
    const topics = [topic(B, { parentTopicId: OTHER })];
    expect(validateTopicGraph(topics)?.code).toBe("unknown-topic");
  });

  test("rejects duplicate Origin Commits", () => {
    const topics = chainMainBCParent();
    topics[1] = { ...topics[1]!, originCommit: "a".repeat(40) };
    topics[2] = { ...topics[2]!, originCommit: "a".repeat(40) };
    expect(validateTopicGraph(topics)?.code).toBe("duplicate-origin-commit");
  });

  test("rejects a fork", () => {
    const topics = chainMainBCParent();
    topics[2] = { ...topics[2]!, integrationTarget: INTEGRATION_BRANCH_NODE };
    expect(validateTopicGraph(topics)?.code).toBe("broken-chain");
  });

  test("rejects a cycle", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(C) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: topicNode(C) }),
      topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
    ];
    expect(validateTopicGraph(topics)?.code).toBe("broken-chain");
  });

  test("rejects a missing Integration Target", () => {
    const topics = [topic(PARENT)];
    expect(validateTopicGraph(topics)?.code).toBe("broken-chain");
  });

  test("bounds every explanation", () => {
    const error = validateTopicGraph([topic(PARENT)]);
    expect(error?.message.length).toBeLessThanOrEqual(200);
  });
});

describe("child insertion", () => {
  test("inserts the first child before the Parent Topic", () => {
    const topics = [topic(PARENT, { integrationTarget: INTEGRATION_BRANCH_NODE })];
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(B, { parentTopicId: PARENT }),
      ancestry: linearAncestry([B, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      {
        topicId: B,
        parentTopicId: PARENT,
        integrationTarget: INTEGRATION_BRANCH_NODE,
        chainState: "active",
      },
      { topicId: PARENT, integrationTarget: topicNode(B) },
    ]);
  });

  test("inserts a last child between the previous child and the Parent Topic", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(B) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(C, { parentTopicId: PARENT }),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: C, parentTopicId: PARENT, integrationTarget: topicNode(B), chainState: "active" },
      { topicId: PARENT, integrationTarget: topicNode(C) },
    ]);
  });

  test("inserts B before C when C was created first", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(C) }),
      topic(C, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(B, { parentTopicId: PARENT }),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      {
        topicId: B,
        parentTopicId: PARENT,
        integrationTarget: INTEGRATION_BRANCH_NODE,
        chainState: "active",
      },
      { topicId: C, integrationTarget: topicNode(B) },
    ]);
  });

  test("inserts a middle child between two existing children", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(D) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(D, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
    ];
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(C, { parentTopicId: PARENT }),
      ancestry: linearAncestry([B, C, D, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: C, parentTopicId: PARENT, integrationTarget: topicNode(B), chainState: "active" },
      { topicId: D, integrationTarget: topicNode(C) },
    ]);
  });

  test("rejects unknown ancestry", () => {
    const topics = chainMainBCParent();
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(D, { parentTopicId: PARENT }),
      ancestry: () => undefined,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("ambiguous-ancestry");
  });

  test("rejects a diverged child", () => {
    const topics = chainMainBCParent();
    const ancestry: AncestryLookup = (ancestor, descendant) =>
      ancestor.kind === "integration-branch" ||
      (ancestor.kind === "topic" &&
        descendant.kind === "topic" &&
        ancestor.topicId === descendant.topicId);
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(D, { parentTopicId: PARENT }),
      ancestry,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("ambiguous-ancestry");
  });

  test("rejects an ancestry order that is not one clean split", () => {
    const topics = chainMainBCParent();
    // D contains C but not B, so it has no single position in `main <- B <- C`.
    const ancestry: AncestryLookup = (ancestor, descendant) => {
      const key = (node: ChainNode) => (node.kind === "integration-branch" ? "main" : node.topicId);
      const left = key(ancestor);
      const right = key(descendant);
      if (left === right) return true;
      if (left === "main") return true;
      if (right === D) return left === C;
      if (left === D) return true;
      return linearAncestry([B, C, PARENT])(ancestor, descendant);
    };
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(D, { parentTopicId: PARENT }),
      ancestry,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("ambiguous-ancestry");
  });

  test("rejects a duplicate Origin Commit", () => {
    const topics = chainMainBCParent();
    topics[1] = { ...topics[1]!, originCommit: "b".repeat(40) };
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(D, { parentTopicId: PARENT, originCommit: "b".repeat(40) }),
      ancestry: linearAncestry([B, C, D, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("duplicate-origin-commit");
  });

  test("rejects a child of another repository", () => {
    const plan = planChildInsertion({
      topics: chainMainBCParent(),
      parentTopicId: PARENT,
      child: { id: D, repository: "acme/other", parentTopicId: PARENT },
      ancestry: linearAncestry([B, C, D, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("cross-repository");
  });

  test("leaves the input graph unchanged after a rejection", () => {
    const topics = chainMainBCParent();
    const snapshot = structuredClone(topics);
    const plan = planChildInsertion({
      topics,
      parentTopicId: PARENT,
      child: topic(D, { parentTopicId: PARENT }),
      ancestry: () => undefined,
    });
    expect(plan.ok).toBe(false);
    expect(topics).toEqual(snapshot);
  });
});

describe("pending activation", () => {
  test("activates a pending child at its ancestry position", () => {
    const topics = [
      ...chainMainBCParent(),
      topic(D, { parentTopicId: PARENT, chainState: "pending" }),
    ];
    const plan = planChildActivation({
      topics,
      topicId: D,
      ancestry: linearAncestry([B, D, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: D, parentTopicId: PARENT, integrationTarget: topicNode(B), chainState: "active" },
      { topicId: C, integrationTarget: topicNode(D) },
    ]);
  });

  test("keeps an ambiguous pending child pending", () => {
    const topics = [
      ...chainMainBCParent(),
      topic(D, { parentTopicId: PARENT, chainState: "pending" }),
    ];
    const plan = planChildActivation({ topics, topicId: D, ancestry: () => undefined });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("ambiguous-ancestry");
  });

  test("rejects activation of an active Topic", () => {
    const plan = planChildActivation({
      topics: chainMainBCParent(),
      topicId: B,
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("not-allowed");
  });
});

describe("deletion", () => {
  test("deleting B plans main <- C <- parent", () => {
    const plan = planTopicDeletion({ topics: chainMainBCParent(), topicId: B });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([{ topicId: C, integrationTarget: INTEGRATION_BRANCH_NODE }]);
  });

  test("deleting the last child reconnects the Parent Topic", () => {
    const plan = planTopicDeletion({ topics: chainMainBCParent(), topicId: C });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([{ topicId: PARENT, integrationTarget: topicNode(B) }]);
  });

  test("deleting a pending child needs no rewiring", () => {
    const topics = [
      ...chainMainBCParent(),
      topic(D, { parentTopicId: PARENT, chainState: "pending" }),
    ];
    const plan = planTopicDeletion({ topics, topicId: D });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([]);
  });

  test("rejects deletion of a Parent Topic that still has children", () => {
    const plan = planTopicDeletion({ topics: chainMainBCParent(), topicId: PARENT });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("not-allowed");
  });
});

describe("parent maintenance", () => {
  test("Remove Parent makes a child a root Topic", () => {
    const plan = planRemoveParent({ topics: chainMainBCParent(), topicId: B });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: C, integrationTarget: INTEGRATION_BRANCH_NODE },
      {
        topicId: B,
        parentTopicId: null,
        integrationTarget: INTEGRATION_BRANCH_NODE,
        chainState: "active",
      },
    ]);
  });

  test("Change Parent moves a child into the new family by ancestry", () => {
    const topics = [
      ...chainMainBCParent(),
      topic(OTHER, { integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    const plan = planChangeParent({
      topics,
      topicId: B,
      newParentTopicId: OTHER,
      ancestry: linearAncestry([B, C, PARENT, OTHER]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: C, integrationTarget: INTEGRATION_BRANCH_NODE },
      {
        topicId: B,
        parentTopicId: OTHER,
        integrationTarget: INTEGRATION_BRANCH_NODE,
        chainState: "active",
      },
      { topicId: OTHER, integrationTarget: topicNode(B) },
    ]);
  });

  test("rejects reparenting under a child Topic", () => {
    const topics = [
      ...chainMainBCParent(),
      topic(OTHER, { integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    const plan = planChangeParent({
      topics,
      topicId: OTHER,
      newParentTopicId: B,
      ancestry: linearAncestry([B, C, PARENT, OTHER]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("nested-child");
  });
});

describe("explicit chain move", () => {
  test("moves C before B and marks the broken edge for confirmation", () => {
    const plan = planChainMove({
      topics: chainMainBCParent(),
      topicId: C,
      target: INTEGRATION_BRANCH_NODE,
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: PARENT, integrationTarget: topicNode(B) },
      {
        topicId: C,
        parentTopicId: PARENT,
        integrationTarget: INTEGRATION_BRANCH_NODE,
        chainState: "active",
      },
      { topicId: B, integrationTarget: topicNode(C) },
    ]);
    expect(plan.value.confirmationRequired).toContain("rebase");
  });

  test("needs no confirmation when ancestry supports the new edges", () => {
    const topics = [
      topic(PARENT, { integrationTarget: topicNode(C) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
    ];
    const plan = planChainMove({
      topics,
      topicId: C,
      target: topicNode(B),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.confirmationRequired).toBeUndefined();
  });

  test("rejects a self target", () => {
    const plan = planChainMove({
      topics: chainMainBCParent(),
      topicId: C,
      target: topicNode(C),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("not-allowed");
  });

  test("rejects a Parent Topic target", () => {
    const plan = planChainMove({
      topics: chainMainBCParent(),
      topicId: B,
      target: topicNode(PARENT),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("not-allowed");
  });

  test("rejects a cross-repository target", () => {
    const topics = [
      ...chainMainBCParent(),
      { id: OTHER, repository: "acme/other", integrationTarget: INTEGRATION_BRANCH_NODE },
    ];
    const plan = planChainMove({
      topics,
      topicId: B,
      target: topicNode(OTHER),
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("cross-repository");
  });
});

describe("Reset Integration Target", () => {
  test("repairs a forked chain from current ancestry", () => {
    const topics = [
      topic(PARENT, { integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(C, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    const plan = planIntegrationTargetReset({
      topics,
      parentTopicId: PARENT,
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: C, integrationTarget: topicNode(B) },
      { topicId: PARENT, integrationTarget: topicNode(C) },
    ]);
    expect(validateTopicGraph(topics)?.code).toBe("broken-chain");
  });

  test("plans nothing for a family that is already correct", () => {
    const plan = planIntegrationTargetReset({
      topics: chainMainBCParent(),
      parentTopicId: PARENT,
      ancestry: linearAncestry([B, C, PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([]);
  });

  test("targets the Integration Branch for a family with no children", () => {
    const plan = planIntegrationTargetReset({
      topics: [topic(PARENT, { integrationTarget: topicNode(B) })],
      parentTopicId: PARENT,
      ancestry: linearAncestry([PARENT]),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.edits).toEqual([
      { topicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE },
    ]);
  });

  test("rejects an ambiguous family and leaves it unchanged", () => {
    const topics = chainMainBCParent();
    const snapshot = structuredClone(topics);
    const plan = planIntegrationTargetReset({
      topics,
      parentTopicId: PARENT,
      ancestry: () => undefined,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.error.code).toBe("ambiguous-ancestry");
    expect(topics).toEqual(snapshot);
  });
});

describe("display child order", () => {
  test("orders active children from the Integration Branch end to the Parent Topic end", () => {
    const children = [
      topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
    ];
    expect(displayChildOrder(children).map((child) => child.id)).toEqual([B, C]);
  });

  test("places a pending child at the intended position that its target records", () => {
    const children = [
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(B) }),
      topic(D, {
        parentTopicId: PARENT,
        integrationTarget: topicNode(B),
        chainState: "pending",
      }),
    ];
    expect(displayChildOrder(children).map((child) => child.id)).toEqual([B, D, C]);
  });

  test("keeps a broken chain renderable instead of failing", () => {
    const children = [
      topic(C, { parentTopicId: PARENT, integrationTarget: topicNode(OTHER) }),
      topic(B, { parentTopicId: PARENT, integrationTarget: INTEGRATION_BRANCH_NODE }),
      topic(D, { parentTopicId: PARENT }),
    ];
    expect(displayChildOrder(children).map((child) => child.id)).toEqual([B, C, D]);
  });
});
