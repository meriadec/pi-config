import { describe, expect, test } from "bun:test";
import { detectLegacyFamilies, planLegacyMigration } from "./index.ts";
import type { AncestryLookup, ChainNode, LegacyTopic } from "./index.ts";

const PARENT = "123e4567-e89b-42d3-a456-426614174000";
const FOO = "123e4567-e89b-42d3-a456-426614174001";
const BAR = "123e4567-e89b-42d3-a456-426614174002";
const OTHER = "123e4567-e89b-42d3-a456-426614174003";
const GRAND = "123e4567-e89b-42d3-a456-426614174004";

/** Ancestry from declared linear tips: a Topic contains every Branch listed before it. */
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

function topic(id: string, name: string, overrides: Partial<LegacyTopic> = {}): LegacyTopic {
  return { id, name, repository: "acme/app", ready: true, ...overrides };
}

/** `Parent`, `Parent > foo`, and `Parent > bar` with tips `foo`, `bar`, then `Parent`. */
function legacyFamily(): LegacyTopic[] {
  return [topic(PARENT, "Parent"), topic(FOO, "Parent > foo"), topic(BAR, "Parent > bar")];
}

describe("legacy family detection", () => {
  test("finds a unique same-repository name family without asking Git", () => {
    const detection = detectLegacyFamilies(legacyFamily());
    expect(detection.families).toEqual([
      { parentTopicId: PARENT, childTopicIds: [FOO, BAR].toSorted() },
    ]);
    expect(detection.skipped).toEqual([]);
  });

  test("ignores Partition while matching names", () => {
    const topics = legacyFamily().map((entry, index) => ({ ...entry, partition: index }));
    expect(detectLegacyFamilies(topics).families).toHaveLength(1);
  });

  test("keeps a Topic that durable data already places out of the migration", () => {
    const topics = [topic(PARENT, "Parent"), topic(FOO, "Parent > foo", { parentTopicId: PARENT })];
    const detection = detectLegacyFamilies(topics);
    expect(detection.families).toEqual([]);
    expect(detection.skipped).toEqual([]);
  });

  test("skips a name with two candidate parents and a name in another repository", () => {
    const topics = [
      topic(PARENT, "Parent"),
      topic(OTHER, "Parent"),
      topic(FOO, "Parent > foo"),
      topic(BAR, "Other > bar", { repository: "acme/other" }),
      topic(GRAND, "Other"),
    ];
    const detection = detectLegacyFamilies(topics);
    expect(detection.families).toEqual([]);
    expect(detection.skipped.map((entry) => [entry.topicId, entry.code])).toEqual([
      [FOO, "ambiguous-name-match"],
      [BAR, "cross-repository"],
    ]);
  });

  test("skips a name with no parent match", () => {
    const detection = detectLegacyFamilies([topic(FOO, "Parent > foo")]);
    expect(detection.skipped.map((entry) => entry.code)).toEqual(["no-parent-match"]);
  });

  test("skips a hierarchy that is deeper than one level", () => {
    const topics = [
      topic(GRAND, "Root"),
      topic(PARENT, "Root > Parent"),
      topic(FOO, "Root > Parent > foo"),
    ];
    const detection = detectLegacyFamilies(topics);
    expect(detection.families).toEqual([]);
    expect(detection.skipped.every((entry) => entry.code === "nested-child")).toBeTrue();
  });

  test("skips a family whose Topic setup is unfinished", () => {
    const topics = legacyFamily().map((entry) =>
      entry.id === FOO ? { ...entry, ready: false } : entry,
    );
    const detection = detectLegacyFamilies(topics);
    expect(detection.families).toEqual([]);
    expect(detection.skipped.map((entry) => entry.code)).toEqual([
      "not-ready",
      "not-ready",
      "not-ready",
    ]);
  });
});

describe("legacy migration preview", () => {
  test("orders children by unambiguous ancestry and targets the Parent Topic last", () => {
    const preview = planLegacyMigration({
      topics: legacyFamily(),
      ancestry: linearAncestry([FOO, BAR, PARENT]),
    });
    expect(preview.skipped).toEqual([]);
    expect(preview.families).toEqual([
      {
        parentTopicId: PARENT,
        children: [
          { topicId: FOO, integrationTarget: { kind: "integration-branch" } },
          { topicId: BAR, integrationTarget: { kind: "topic", topicId: FOO } },
        ],
        parentIntegrationTarget: { kind: "topic", topicId: BAR },
      },
    ]);
  });

  test("leaves a family whose children have diverged unchanged", () => {
    const preview = planLegacyMigration({
      topics: legacyFamily(),
      ancestry: (ancestor, descendant) =>
        ancestor.kind === "topic" && descendant.kind === "topic"
          ? descendant.topicId === PARENT && ancestor.topicId !== PARENT
          : undefined,
    });
    expect(preview.families).toEqual([]);
    expect(preview.skipped.map((entry) => entry.code)).toEqual(["ambiguous-ancestry"]);
  });

  test("leaves a family whose Parent Topic does not contain a child unchanged", () => {
    const preview = planLegacyMigration({
      topics: legacyFamily(),
      ancestry: linearAncestry([FOO, PARENT, BAR]),
    });
    expect(preview.families).toEqual([]);
    expect(preview.skipped.map((entry) => [entry.topicId, entry.code])).toEqual([
      [PARENT, "ambiguous-ancestry"],
    ]);
  });

  test("migrates a safe family while another family stays ambiguous", () => {
    const secondParent = "123e4567-e89b-42d3-a456-426614174005";
    const secondChild = "123e4567-e89b-42d3-a456-426614174006";
    const topics = [
      ...legacyFamily(),
      topic(secondParent, "Second"),
      topic(secondChild, "Second > child"),
    ];
    const preview = planLegacyMigration({
      topics,
      // The second family has no ancestry answer at all, so it cannot be ordered.
      ancestry: linearAncestry([FOO, BAR, PARENT]),
    });
    expect(preview.families.map((family) => family.parentTopicId)).toEqual([PARENT]);
    expect(preview.skipped.map((entry) => entry.topicId)).toEqual([secondParent]);
  });

  test("keeps a single-child family in one chain from the Integration Branch", () => {
    const topics = [topic(PARENT, "Parent"), topic(FOO, "Parent > foo")];
    const preview = planLegacyMigration({
      topics,
      ancestry: linearAncestry([FOO, PARENT]),
    });
    expect(preview.families[0]).toEqual({
      parentTopicId: PARENT,
      children: [{ topicId: FOO, integrationTarget: { kind: "integration-branch" } }],
      parentIntegrationTarget: { kind: "topic", topicId: FOO },
    });
  });
});
