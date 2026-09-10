import { planIntegrationTargetReset, topicNode } from "./integration-chain.ts";
import type { AncestryLookup, ChainTopic } from "./integration-chain.ts";
import type { IntegrationTarget } from "./domain.ts";

/**
 * The read-only planner of the legacy name hierarchy migration. It reads Topic names,
 * durable relationship data, and committed Git ancestry answers, and it returns one
 * preview: the families that can take durable Parent and Integration Target data, and
 * every Topic that stays unchanged with its reason. It never writes and never runs Git;
 * a caller supplies ancestry answers and applies an approved preview atomically.
 */

/** The name separator of a legacy Topic name hierarchy, for example `Parent > child`. */
export const LEGACY_NAME_SEPARATOR = " > ";

/** Upper bound that keeps every migration explanation small and printable. */
export const MAX_MIGRATION_MESSAGE_LENGTH = 200;

/** The migration-relevant part of a Topic. It is structurally a subset of a manifest. */
export interface LegacyTopic extends ChainTopic {
  name: string;
  /** False for a Topic whose Worktree setup is unfinished; such a Topic never migrates. */
  ready?: boolean;
}

export type LegacySkipCode =
  | "no-parent-match"
  | "ambiguous-name-match"
  | "cross-repository"
  | "nested-child"
  | "not-ready"
  | "ambiguous-ancestry"
  | "unusable-family";

/** One Topic that the migration leaves unchanged, with a bounded reason. */
export interface LegacyMigrationSkip {
  topicId: string;
  code: LegacySkipCode;
  message: string;
}

/** One proposed durable child placement, in Integration Chain order. */
export interface LegacyMigrationChild {
  topicId: string;
  integrationTarget: IntegrationTarget;
}

/** One family that migration can move to durable metadata as a whole. */
export interface LegacyMigrationFamily {
  parentTopicId: string;
  /** Children from the Integration Branch end to the Parent Topic end. */
  children: readonly LegacyMigrationChild[];
  /** The Integration Target that the Parent Topic takes after migration. */
  parentIntegrationTarget: IntegrationTarget;
}

export interface LegacyMigrationPreview {
  families: readonly LegacyMigrationFamily[];
  skipped: readonly LegacyMigrationSkip[];
}

/** One legacy family found by name only, before any Git question is asked. */
export interface LegacyNameFamily {
  parentTopicId: string;
  childTopicIds: readonly string[];
}

export interface LegacyDetection {
  families: readonly LegacyNameFamily[];
  skipped: readonly LegacyMigrationSkip[];
}

/**
 * Finds unresolved legacy families by name only. Matching uses the unique same-repository
 * Topic whose name equals the parent part of a ` > ` name, and it ignores Partition. Detection
 * asks no Git question and changes nothing, so the daemon can run it at startup.
 */
export function detectLegacyFamilies(topics: readonly LegacyTopic[]): LegacyDetection {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const byName = new Map<string, LegacyTopic[]>();
  for (const topic of topics) {
    const matches = byName.get(topic.name);
    if (matches === undefined) byName.set(topic.name, [topic]);
    else matches.push(topic);
  }

  const skipped: LegacyMigrationSkip[] = [];
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const topic of topics) {
    // A Topic that durable data already places is not part of a legacy family.
    if (topic.parentTopicId !== undefined) continue;
    const parentName = legacyParentName(topic.name);
    if (parentName === undefined) continue;
    const named = byName.get(parentName) ?? [];
    const candidates = named.filter(
      (candidate) => candidate.id !== topic.id && candidate.repository === topic.repository,
    );
    if (candidates.length === 0) {
      skipped.push(
        skip(
          topic.id,
          named.length === 0 ? "no-parent-match" : "cross-repository",
          named.length === 0
            ? `No Topic is named ${quote(parentName)}.`
            : `Topic ${quote(parentName)} is in another repository.`,
        ),
      );
      continue;
    }
    if (candidates.length > 1) {
      skipped.push(
        skip(
          topic.id,
          "ambiguous-name-match",
          `${candidates.length} Topics are named ${quote(parentName)}.`,
        ),
      );
      continue;
    }
    const parent = candidates[0]!;
    if (parent.parentTopicId !== undefined) {
      skipped.push(
        skip(topic.id, "nested-child", `Topic ${quote(parentName)} is already a child Topic.`),
      );
      continue;
    }
    parentOf.set(topic.id, parent.id);
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), topic.id]);
  }

  const families: LegacyNameFamily[] = [];
  for (const [parentTopicId, childTopicIds] of childrenOf) {
    const members = [parentTopicId, ...childTopicIds];
    // One level only: a Topic that is both a parent and a child cannot migrate.
    const deeper = parentOf.has(parentTopicId) || childTopicIds.some((id) => childrenOf.has(id));
    if (deeper) {
      for (const id of members) {
        skipped.push(skip(id, "nested-child", "The name hierarchy is deeper than one level."));
      }
      continue;
    }
    const unfinished = members.filter((id) => byId.get(id)?.ready === false);
    if (unfinished.length > 0) {
      for (const id of members) {
        skipped.push(skip(id, "not-ready", "A Topic of this family is not ready."));
      }
      continue;
    }
    families.push({ parentTopicId, childTopicIds: childTopicIds.toSorted() });
  }
  families.sort((left, right) => left.parentTopicId.localeCompare(right.parentTopicId));
  return { families, skipped: boundedSkips(skipped) };
}

export interface LegacyMigrationInput {
  topics: readonly LegacyTopic[];
  /** Committed Git ancestry between the Branch tips of two Topics of one family. */
  ancestry: AncestryLookup;
}

/**
 * Builds the complete read-only migration preview. Each detected family keeps its Parent
 * Topic and receives the child order that current Git ancestry makes unambiguous. A family
 * whose ancestry is not one clean order stays unchanged, and does not stop another family.
 */
export function planLegacyMigration(input: LegacyMigrationInput): LegacyMigrationPreview {
  const detection = detectLegacyFamilies(input.topics);
  const byId = new Map(input.topics.map((topic) => [topic.id, topic]));
  const families: LegacyMigrationFamily[] = [];
  const skipped: LegacyMigrationSkip[] = [...detection.skipped];

  for (const family of detection.families) {
    const parent = byId.get(family.parentTopicId);
    const children = family.childTopicIds.map((id) => byId.get(id));
    if (parent === undefined || children.some((child) => child === undefined)) continue;
    const members = children as LegacyTopic[];

    const unrelated = members.find(
      (child) => input.ancestry(topicNode(child.id), topicNode(parent.id)) !== true,
    );
    if (unrelated !== undefined) {
      skipped.push(
        skip(
          family.parentTopicId,
          "ambiguous-ancestry",
          `Topic ${short(parent.id)} does not contain ${short(unrelated.id)}.`,
        ),
      );
      continue;
    }

    // The chain engine owns ordering, so migration and every later chain action agree.
    const candidate: ChainTopic[] = [
      { id: parent.id, repository: parent.repository },
      ...members.map((child) => ({
        id: child.id,
        repository: child.repository,
        parentTopicId: parent.id,
      })),
    ];
    const plan = planIntegrationTargetReset({
      topics: candidate,
      parentTopicId: parent.id,
      ancestry: input.ancestry,
    });
    if (!plan.ok) {
      skipped.push(
        skip(
          family.parentTopicId,
          plan.error.code === "ambiguous-ancestry" ? "ambiguous-ancestry" : "unusable-family",
          plan.error.message,
        ),
      );
      continue;
    }

    const targets = new Map<string, IntegrationTarget>();
    for (const edit of plan.value.edits) {
      if (edit.integrationTarget !== undefined) targets.set(edit.topicId, edit.integrationTarget);
    }
    const parentIntegrationTarget = targets.get(parent.id);
    const placed = members.map((child) => ({
      topicId: child.id,
      integrationTarget: targets.get(child.id),
    }));
    if (
      parentIntegrationTarget === undefined ||
      placed.some((entry) => entry.integrationTarget === undefined)
    ) {
      skipped.push(
        skip(family.parentTopicId, "unusable-family", "The chain plan does not cover this family."),
      );
      continue;
    }
    families.push({
      parentTopicId: parent.id,
      children: chainOrder(placed as LegacyMigrationChild[], parent.id),
      parentIntegrationTarget,
    });
  }
  return { families, skipped: boundedSkips(skipped) };
}

/** The parent part of a legacy Topic name, or undefined when the name has no hierarchy. */
export function legacyParentName(name: string): string | undefined {
  const index = name.lastIndexOf(LEGACY_NAME_SEPARATOR);
  if (index <= 0) return undefined;
  const parentName = name.slice(0, index);
  return parentName.length === 0 ? undefined : parentName;
}

/** Proposed children in chain order, from the Integration Branch end to the Parent Topic. */
function chainOrder(
  children: readonly LegacyMigrationChild[],
  parentTopicId: string,
): LegacyMigrationChild[] {
  const bySource = new Map<string, LegacyMigrationChild>();
  for (const child of children) {
    const target = child.integrationTarget;
    bySource.set(target.kind === "integration-branch" ? "" : target.topicId, child);
  }
  const ordered: LegacyMigrationChild[] = [];
  let cursor = "";
  while (ordered.length < children.length) {
    const next = bySource.get(cursor);
    if (next === undefined || next.topicId === parentTopicId) break;
    ordered.push(next);
    cursor = next.topicId;
  }
  for (const child of children) {
    if (!ordered.includes(child)) ordered.push(child);
  }
  return ordered;
}

const MAX_SKIPS = 100;

function boundedSkips(skipped: readonly LegacyMigrationSkip[]): LegacyMigrationSkip[] {
  return skipped.slice(0, MAX_SKIPS);
}

function skip(topicId: string, code: LegacySkipCode, message: string): LegacyMigrationSkip {
  return { topicId, code, message: bound(message) };
}

function quote(name: string): string {
  const trimmed = name.length <= 60 ? name : `${name.slice(0, 59)}…`;
  return `"${trimmed}"`;
}

function short(topicId: string): string {
  return topicId.slice(0, 8);
}

function bound(message: string): string {
  return message.length <= MAX_MIGRATION_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_MIGRATION_MESSAGE_LENGTH - 1)}…`;
}
