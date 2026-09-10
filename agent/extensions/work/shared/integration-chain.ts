import type { IntegrationTarget, TopicChainState } from "./domain.ts";

/**
 * The pure Integration Chain engine. It validates one-level Topic families, derives the
 * single ordered path from the Integration Branch through the children to the Parent
 * Topic, and plans every chain mutation as data. It never reads Git, never touches a
 * store, and never mutates its input; a caller applies an accepted plan atomically.
 */

/** Upper bound that keeps every rejection explanation small and printable. */
export const MAX_CHAIN_MESSAGE_LENGTH = 200;

/** One end of an Integration Chain edge: the Integration Branch or a family Topic. */
export type ChainNode = IntegrationTarget;

/** The chain-relevant part of a Topic. It is structurally a subset of a Topic manifest. */
export interface ChainTopic {
  id: string;
  repository: string;
  parentTopicId?: string | undefined;
  originCommit?: string | undefined;
  integrationTarget?: IntegrationTarget | undefined;
  chainState?: TopicChainState | undefined;
}

/**
 * Current Git ancestry between two chain nodes, as committed local Branch tips.
 * Returns true when the `ancestor` tip is contained in the `descendant` tip, false when
 * it is not, and undefined when Git cannot give a reliable answer.
 */
export type AncestryLookup = (ancestor: ChainNode, descendant: ChainNode) => boolean | undefined;

export type ChainErrorCode =
  | "unknown-topic"
  | "nested-child"
  | "cross-repository"
  | "duplicate-origin-commit"
  | "broken-chain"
  | "ambiguous-ancestry"
  | "not-allowed";

export interface ChainError {
  code: ChainErrorCode;
  message: string;
}

/** One durable change to a single Topic. `parentTopicId: null` clears the Parent Topic. */
export interface ChainEdit {
  topicId: string;
  parentTopicId?: string | null;
  integrationTarget?: IntegrationTarget;
  chainState?: TopicChainState;
}

export interface ChainPlan {
  edits: ChainEdit[];
  /** Set when the plan creates an edge that current Git ancestry does not support. */
  confirmationRequired?: string;
}

export type ChainResult<T> = { ok: true; value: T } | { ok: false; error: ChainError };

/** One validated family: the root Parent Topic, its ordered active children, and pending children. */
export interface ChainFamily {
  parent: ChainTopic;
  /** Active children from the Integration Branch end to the Parent Topic end. */
  children: ChainTopic[];
  pending: ChainTopic[];
}

export const INTEGRATION_BRANCH_NODE: ChainNode = { kind: "integration-branch" };

/** A chain node for one Topic. */
export function topicNode(topicId: string): ChainNode {
  return { kind: "topic", topicId };
}

/** True when two chain nodes name the same Branch. */
export function sameChainNode(left: ChainNode, right: ChainNode): boolean {
  return chainNodeKey(left) === chainNodeKey(right);
}

/**
 * Validates every family in a Topic set. Returns undefined when the graph holds one-level
 * families and each family keeps exactly one ordered path to its Parent Topic.
 */
export function validateTopicGraph(topics: readonly ChainTopic[]): ChainError | undefined {
  const index = indexTopics(topics);
  if (!index.ok) return index.error;
  for (const topic of topics) {
    if (topic.parentTopicId !== undefined) continue;
    const family = readFamily(index.value, topic.id);
    if (!family.ok) return family.error;
  }
  return undefined;
}

/**
 * The validated family of one Parent Topic, with its active children in chain order.
 */
export function resolveFamily(
  topics: readonly ChainTopic[],
  parentTopicId: string,
): ChainResult<ChainFamily> {
  const index = indexTopics(topics);
  if (!index.ok) return index;
  return readFamily(index.value, parentTopicId);
}

/**
 * The total display order of one Parent Topic's children, from the Integration Branch end
 * to the Parent Topic end. Unlike `resolveFamily` it never fails, because a view must stay
 * renderable: a broken or forked chain keeps its resolvable prefix and shows the remaining
 * children after it, and every pending child appears at the position that its durable
 * Integration Target records.
 */
export function displayChildOrder<T extends ChainTopic>(children: readonly T[]): T[] {
  const active = children.filter((child) => child.chainState !== "pending");
  const bySource = new Map<string, T>();
  for (const child of active) {
    const target = child.integrationTarget;
    if (target === undefined) continue;
    const key = chainNodeKey(target);
    if (!bySource.has(key)) bySource.set(key, child);
  }

  const ordered: T[] = [];
  const placed = new Set<string>();
  let cursor: ChainNode = INTEGRATION_BRANCH_NODE;
  for (;;) {
    const next = bySource.get(chainNodeKey(cursor));
    if (next === undefined || placed.has(next.id)) break;
    ordered.push(next);
    placed.add(next.id);
    cursor = topicNode(next.id);
  }
  for (const child of active) {
    if (placed.has(child.id)) continue;
    ordered.push(child);
    placed.add(child.id);
  }

  for (const child of children) {
    if (child.chainState !== "pending") continue;
    const target = child.integrationTarget;
    const successor =
      target === undefined
        ? -1
        : target.kind === "integration-branch"
          ? 0
          : indexAfter(ordered, target.topicId);
    if (successor < 0) ordered.push(child);
    else ordered.splice(successor, 0, child);
  }
  return ordered;
}

/** The position directly after one Topic, or -1 when the ordered children exclude it. */
function indexAfter(ordered: readonly ChainTopic[], topicId: string): number {
  const index = ordered.findIndex((item) => item.id === topicId);
  return index < 0 ? -1 : index + 1;
}

export interface ChildInsertionInput {
  topics: readonly ChainTopic[];
  parentTopicId: string;
  /** The child to insert. It may already exist as a pending Topic of the same family. */
  child: ChainTopic;
  ancestry: AncestryLookup;
}

/**
 * Plans insertion of one child into its family by current Git ancestry, in creation order
 * or out of order. It activates the child and rewires exactly one successor edge.
 */
export function planChildInsertion(input: ChildInsertionInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const family = readFamily(index.value, input.parentTopicId);
  if (!family.ok) return family;
  const parent = family.value.parent;
  const child = input.child;
  if (child.id === parent.id) {
    return failure("not-allowed", "A Parent Topic cannot be a child of itself.");
  }
  if (child.repository !== parent.repository) {
    return failure("cross-repository", `Child ${short(child.id)} is in another repository.`);
  }
  const existing = index.value.byId.get(child.id);
  if (existing !== undefined) {
    if (existing.parentTopicId !== undefined && existing.parentTopicId !== parent.id) {
      return failure("not-allowed", `Topic ${short(child.id)} belongs to another family.`);
    }
    if (existing.chainState === "active" && existing.parentTopicId === parent.id) {
      return failure("not-allowed", `Topic ${short(child.id)} is already in the chain.`);
    }
    if ((index.value.childrenOf.get(child.id)?.length ?? 0) > 0) {
      return failure("nested-child", `Topic ${short(child.id)} is a Parent Topic.`);
    }
  }
  const duplicate = duplicateOriginCommit(family.value, child);
  if (duplicate !== undefined) return duplicate;

  const position = planPosition(family.value.children, child, input.ancestry);
  if (!position.ok) return position;
  return { ok: true, value: { edits: insertEdits(family.value, child, position.value) } };
}

export interface ChildActivationInput {
  topics: readonly ChainTopic[];
  topicId: string;
  ancestry: AncestryLookup;
}

/**
 * Plans activation of a pending child that finished provisioning. A pending child that
 * became ambiguous stays pending, so the healthy chain is preserved.
 */
export function planChildActivation(input: ChildActivationInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const topic = index.value.byId.get(input.topicId);
  if (topic === undefined) {
    return failure("unknown-topic", `Topic ${short(input.topicId)} does not exist.`);
  }
  if (topic.chainState !== "pending") {
    return failure("not-allowed", `Topic ${short(input.topicId)} is not pending.`);
  }
  if (topic.parentTopicId === undefined) {
    return failure("not-allowed", `Topic ${short(input.topicId)} has no Parent Topic.`);
  }
  return planChildInsertion({
    topics: input.topics,
    parentTopicId: topic.parentTopicId,
    child: topic,
    ancestry: input.ancestry,
  });
}

export interface ChainDetachInput {
  topics: readonly ChainTopic[];
  topicId: string;
}

/**
 * Plans the chain rewiring for deletion of one Topic. Deleting a child reconnects its
 * successor to the child's own Integration Target; deleting a Parent Topic that still
 * has children is rejected. The plan never contains an edit for the deleted Topic.
 */
export function planTopicDeletion(input: ChainDetachInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const topic = index.value.byId.get(input.topicId);
  if (topic === undefined) {
    return failure("unknown-topic", `Topic ${short(input.topicId)} does not exist.`);
  }
  if ((index.value.childrenOf.get(topic.id)?.length ?? 0) > 0) {
    return failure("not-allowed", `Topic ${short(topic.id)} still has children.`);
  }
  if (topic.parentTopicId === undefined) return { ok: true, value: { edits: [] } };
  const family = readFamily(index.value, topic.parentTopicId);
  if (!family.ok) return family;
  return { ok: true, value: { edits: detachEdits(family.value, topic.id) } };
}

/** Plans the change that makes a child a root Topic again, targeting the Integration Branch. */
export function planRemoveParent(input: ChainDetachInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const topic = index.value.byId.get(input.topicId);
  if (topic === undefined) {
    return failure("unknown-topic", `Topic ${short(input.topicId)} does not exist.`);
  }
  if (topic.parentTopicId === undefined) {
    return failure("not-allowed", `Topic ${short(topic.id)} is already a root Topic.`);
  }
  const family = readFamily(index.value, topic.parentTopicId);
  if (!family.ok) return family;
  const edits = detachEdits(family.value, topic.id);
  edits.push({
    topicId: topic.id,
    parentTopicId: null,
    integrationTarget: INTEGRATION_BRANCH_NODE,
    chainState: "active",
  });
  return { ok: true, value: { edits } };
}

export interface ChangeParentInput {
  topics: readonly ChainTopic[];
  topicId: string;
  newParentTopicId: string;
  ancestry: AncestryLookup;
}

/**
 * Plans reparenting: the Topic leaves its old chain and enters the new family at the
 * position that current Git ancestry makes unambiguous.
 */
export function planChangeParent(input: ChangeParentInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const topic = index.value.byId.get(input.topicId);
  if (topic === undefined) {
    return failure("unknown-topic", `Topic ${short(input.topicId)} does not exist.`);
  }
  const newParent = index.value.byId.get(input.newParentTopicId);
  if (newParent === undefined) {
    return failure("unknown-topic", `Topic ${short(input.newParentTopicId)} does not exist.`);
  }
  if (newParent.id === topic.id) {
    return failure("not-allowed", "A Topic cannot be its own Parent Topic.");
  }
  if (newParent.parentTopicId !== undefined) {
    return failure("nested-child", `Topic ${short(newParent.id)} is already a child.`);
  }
  if ((index.value.childrenOf.get(topic.id)?.length ?? 0) > 0) {
    return failure("nested-child", `Topic ${short(topic.id)} is a Parent Topic.`);
  }
  if (topic.parentTopicId === newParent.id) {
    return failure("not-allowed", `Topic ${short(topic.id)} already has this Parent Topic.`);
  }

  const edits: ChainEdit[] = [];
  if (topic.parentTopicId !== undefined) {
    const oldFamily = readFamily(index.value, topic.parentTopicId);
    if (!oldFamily.ok) return oldFamily;
    edits.push(...detachEdits(oldFamily.value, topic.id));
  }
  const remaining = input.topics.filter((entry) => entry.id !== topic.id);
  const insertion = planChildInsertion({
    topics: remaining,
    parentTopicId: newParent.id,
    child: { ...topic, parentTopicId: newParent.id, chainState: "pending" },
    ancestry: input.ancestry,
  });
  if (!insertion.ok) return insertion;
  edits.push(...insertion.value.edits);
  return { ok: true, value: { edits: mergeEdits(edits) } };
}

export interface ChainMoveInput {
  topics: readonly ChainTopic[];
  topicId: string;
  /** The chain node that the moved Topic must integrate into. */
  target: ChainNode;
  ancestry: AncestryLookup;
}

/**
 * Plans an explicit move inside one Integration Chain. It preserves one ordered path and
 * rejects cycles and cross-repository links. It can plan an edge that current ancestry
 * does not support, and then reports that confirmation is required.
 */
export function planChainMove(input: ChainMoveInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const topic = index.value.byId.get(input.topicId);
  if (topic === undefined) {
    return failure("unknown-topic", `Topic ${short(input.topicId)} does not exist.`);
  }
  if (topic.parentTopicId === undefined) {
    return failure("not-allowed", `Topic ${short(topic.id)} is not a child Topic.`);
  }
  const family = readFamily(index.value, topic.parentTopicId);
  if (!family.ok) return family;
  if (input.target.kind === "topic") {
    const target = index.value.byId.get(input.target.topicId);
    if (target === undefined) {
      return failure("unknown-topic", `Topic ${short(input.target.topicId)} does not exist.`);
    }
    if (target.id === topic.id) {
      return failure("not-allowed", "A Topic cannot integrate into itself.");
    }
    if (target.repository !== topic.repository) {
      return failure("cross-repository", `Topic ${short(target.id)} is in another repository.`);
    }
    if (target.id === family.value.parent.id) {
      return failure("not-allowed", "A child cannot integrate into its Parent Topic.");
    }
    if (target.parentTopicId !== family.value.parent.id) {
      return failure("not-allowed", `Topic ${short(target.id)} is in another family.`);
    }
    if (!family.value.children.some((entry) => entry.id === target.id)) {
      return failure("not-allowed", `Topic ${short(target.id)} is not in the chain.`);
    }
  }

  const moveTarget = input.target;
  const order = family.value.children.filter((entry) => entry.id !== topic.id);
  const position =
    moveTarget.kind === "integration-branch"
      ? 0
      : order.findIndex((entry) => entry.id === moveTarget.topicId) + 1;
  if (position === 0 && moveTarget.kind === "topic") {
    return failure("not-allowed", "The Integration Target left the chain.");
  }
  const detached: ChainFamily = { ...family.value, children: order };
  const edits = mergeEdits([
    ...detachEdits(family.value, topic.id),
    ...insertEdits(detached, topic, position),
  ]);
  const broken = brokenEdges(detached, topic, position, input.ancestry);
  return {
    ok: true,
    value: broken === undefined ? { edits } : { edits, confirmationRequired: broken },
  };
}

export interface ChainResetInput {
  topics: readonly ChainTopic[];
  parentTopicId: string;
  ancestry: AncestryLookup;
}

/**
 * Plans a full rebuild of one family's Integration Chain from current Git ancestry. It
 * repairs broken links, and refuses any family whose ancestry does not give one order.
 */
export function planIntegrationTargetReset(input: ChainResetInput): ChainResult<ChainPlan> {
  const index = indexTopics(input.topics);
  if (!index.ok) return index;
  const collected = collectFamily(index.value, input.parentTopicId);
  if (!collected.ok) return collected;
  const parent = collected.value.parent;
  const ordered: ChainTopic[] = [];
  for (const child of collected.value.children) {
    const position = planPosition(ordered, child, input.ancestry);
    if (!position.ok) return position;
    ordered.splice(position.value, 0, child);
  }
  const edits: ChainEdit[] = [];
  ordered.forEach((child, position) => {
    const target = predecessorNode(ordered, position);
    if (child.integrationTarget === undefined || !sameChainNode(child.integrationTarget, target)) {
      edits.push({ topicId: child.id, integrationTarget: target });
    }
  });
  const last = ordered.at(-1);
  const parentTarget = last === undefined ? INTEGRATION_BRANCH_NODE : topicNode(last.id);
  if (
    parent.integrationTarget === undefined ||
    !sameChainNode(parent.integrationTarget, parentTarget)
  ) {
    edits.push({ topicId: parent.id, integrationTarget: parentTarget });
  }
  return { ok: true, value: { edits } };
}

interface TopicIndex {
  byId: Map<string, ChainTopic>;
  childrenOf: Map<string, ChainTopic[]>;
}

function indexTopics(topics: readonly ChainTopic[]): ChainResult<TopicIndex> {
  const byId = new Map<string, ChainTopic>();
  for (const topic of topics) {
    if (byId.has(topic.id)) {
      return failure("not-allowed", `Topic ${short(topic.id)} appears twice.`);
    }
    byId.set(topic.id, topic);
  }
  const childrenOf = new Map<string, ChainTopic[]>();
  for (const topic of topics) {
    const parentId = topic.parentTopicId;
    if (parentId === undefined) continue;
    if (parentId === topic.id) {
      return failure("not-allowed", `Topic ${short(topic.id)} is its own Parent Topic.`);
    }
    const parent = byId.get(parentId);
    if (parent === undefined) {
      return failure("unknown-topic", `Topic ${short(topic.id)} names a missing Parent Topic.`);
    }
    if (parent.parentTopicId !== undefined) {
      return failure("nested-child", `Topic ${short(topic.id)} is nested under a child Topic.`);
    }
    if (parent.repository !== topic.repository) {
      return failure("cross-repository", `Topic ${short(topic.id)} is in another repository.`);
    }
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) childrenOf.set(parentId, [topic]);
    else siblings.push(topic);
  }
  return { ok: true, value: { byId, childrenOf } };
}

/** The structural family of one Parent Topic, without any chain-link validation. */
function collectFamily(index: TopicIndex, parentTopicId: string): ChainResult<ChainFamily> {
  const parent = index.byId.get(parentTopicId);
  if (parent === undefined) {
    return failure("unknown-topic", `Topic ${short(parentTopicId)} does not exist.`);
  }
  if (parent.parentTopicId !== undefined) {
    return failure("nested-child", `Topic ${short(parentTopicId)} is not a Parent Topic.`);
  }
  const members = index.childrenOf.get(parentTopicId) ?? [];
  const origins = new Set<string>();
  for (const child of members) {
    const origin = child.originCommit;
    if (origin === undefined) continue;
    if (origins.has(origin)) {
      return failure(
        "duplicate-origin-commit",
        `Two children of ${short(parentTopicId)} share Origin Commit ${origin.slice(0, 8)}.`,
      );
    }
    origins.add(origin);
  }
  return {
    ok: true,
    value: {
      parent,
      children: members.filter((child) => child.chainState !== "pending"),
      pending: members.filter((child) => child.chainState === "pending"),
    },
  };
}

/** The family of one Parent Topic with the single ordered path through its active children. */
function readFamily(index: TopicIndex, parentTopicId: string): ChainResult<ChainFamily> {
  const collected = collectFamily(index, parentTopicId);
  if (!collected.ok) return collected;
  const { parent, children, pending } = collected.value;
  const members = [...children, parent];
  const bySource = new Map<string, ChainTopic>();
  for (const member of members) {
    const target = member.integrationTarget;
    if (target === undefined) {
      return failure("broken-chain", `Topic ${short(member.id)} has no Integration Target.`);
    }
    if (target.kind === "topic" && !children.some((child) => child.id === target.topicId)) {
      return failure(
        "broken-chain",
        `Topic ${short(member.id)} targets ${short(target.topicId)} outside its chain.`,
      );
    }
    const key = chainNodeKey(target);
    if (bySource.has(key)) {
      return failure("broken-chain", `The chain of ${short(parent.id)} forks at ${key}.`);
    }
    bySource.set(key, member);
  }

  const ordered: ChainTopic[] = [];
  let cursor: ChainNode = INTEGRATION_BRANCH_NODE;
  for (;;) {
    const next = bySource.get(chainNodeKey(cursor));
    if (next === undefined) {
      return failure("broken-chain", `The chain of ${short(parent.id)} does not reach its end.`);
    }
    if (next.id === parent.id) break;
    ordered.push(next);
    if (ordered.length > children.length) {
      return failure("broken-chain", `The chain of ${short(parent.id)} contains a cycle.`);
    }
    cursor = topicNode(next.id);
  }
  if (ordered.length !== children.length) {
    return failure(
      "broken-chain",
      `The chain of ${short(parent.id)} leaves a child outside the path.`,
    );
  }
  return { ok: true, value: { parent, children: ordered, pending } };
}

/**
 * The unambiguous position of one child among ordered siblings: the number of siblings
 * whose tip the child already contains. Ancestry that is unknown, mutual, or divergent,
 * and any order that is not a clean split, is ambiguous.
 */
function planPosition(
  children: readonly ChainTopic[],
  child: ChainTopic,
  ancestry: AncestryLookup,
): ChainResult<number> {
  const childNode = topicNode(child.id);
  let position = 0;
  let seenSuccessor = false;
  for (const sibling of children) {
    const siblingNode = topicNode(sibling.id);
    const contains = ancestry(siblingNode, childNode);
    const contained = ancestry(childNode, siblingNode);
    if (contains === undefined || contained === undefined) {
      return failure(
        "ambiguous-ancestry",
        `Git ancestry between ${short(child.id)} and ${short(sibling.id)} is unknown.`,
      );
    }
    if (contains && contained) {
      return failure(
        "ambiguous-ancestry",
        `Topics ${short(child.id)} and ${short(sibling.id)} have the same tip.`,
      );
    }
    if (!contains && !contained) {
      return failure(
        "ambiguous-ancestry",
        `Topics ${short(child.id)} and ${short(sibling.id)} have diverged.`,
      );
    }
    if (contains) {
      if (seenSuccessor) {
        return failure(
          "ambiguous-ancestry",
          `Ancestry of ${short(child.id)} does not give one chain position.`,
        );
      }
      position += 1;
    } else {
      seenSuccessor = true;
    }
  }
  return { ok: true, value: position };
}

/** The edits that insert one child at `position` of an already detached chain. */
function insertEdits(family: ChainFamily, child: ChainTopic, position: number): ChainEdit[] {
  const predecessor = predecessorNode(family.children, position);
  const successor = family.children[position] ?? family.parent;
  return [
    {
      topicId: child.id,
      parentTopicId: family.parent.id,
      integrationTarget: predecessor,
      chainState: "active",
    },
    { topicId: successor.id, integrationTarget: topicNode(child.id) },
  ];
}

/** The edits that reconnect the successor of one child to that child's Integration Target. */
function detachEdits(family: ChainFamily, topicId: string): ChainEdit[] {
  const position = family.children.findIndex((child) => child.id === topicId);
  if (position < 0) return [];
  const removed = family.children[position];
  const target = removed?.integrationTarget;
  if (target === undefined) return [];
  const successor = family.children[position + 1] ?? family.parent;
  return [{ topicId: successor.id, integrationTarget: target }];
}

/** A bounded explanation of the chain edges that current Git ancestry does not support. */
function brokenEdges(
  family: ChainFamily,
  child: ChainTopic,
  position: number,
  ancestry: AncestryLookup,
): string | undefined {
  const childNode = topicNode(child.id);
  const predecessor = predecessorNode(family.children, position);
  const successor = family.children[position] ?? family.parent;
  const broken: string[] = [];
  if (ancestry(predecessor, childNode) !== true) {
    broken.push(`${short(child.id)} does not contain ${chainNodeKey(predecessor)}`);
  }
  if (successor.id !== child.id && ancestry(childNode, topicNode(successor.id)) !== true) {
    broken.push(`${short(successor.id)} does not contain ${short(child.id)}`);
  }
  if (broken.length === 0) return undefined;
  return bound(`The move needs a rebase: ${broken.join("; ")}.`);
}

/** Later edits for one Topic win, so a detach edit never survives a following insert edit. */
function mergeEdits(edits: readonly ChainEdit[]): ChainEdit[] {
  const merged = new Map<string, ChainEdit>();
  for (const edit of edits) {
    const previous = merged.get(edit.topicId);
    merged.set(edit.topicId, previous === undefined ? edit : { ...previous, ...edit });
  }
  return [...merged.values()];
}

function duplicateOriginCommit(
  family: ChainFamily,
  child: ChainTopic,
): { ok: false; error: ChainError } | undefined {
  const origin = child.originCommit;
  if (origin === undefined) return undefined;
  const clash = [...family.children, ...family.pending].some(
    (entry) => entry.id !== child.id && entry.originCommit === origin,
  );
  if (!clash) return undefined;
  return failure(
    "duplicate-origin-commit",
    `Another child already starts at Origin Commit ${origin.slice(0, 8)}.`,
  );
}

/** The chain node that a member at `position` integrates into. */
function predecessorNode(children: readonly ChainTopic[], position: number): ChainNode {
  const predecessor = children[position - 1];
  return predecessor === undefined ? INTEGRATION_BRANCH_NODE : topicNode(predecessor.id);
}

/** The stable identity of one chain node, usable as a map key. */
export function chainNodeKey(node: ChainNode): string {
  return node.kind === "integration-branch" ? "integration-branch" : `topic:${node.topicId}`;
}

function short(topicId: string): string {
  return topicId.slice(0, 8);
}

function bound(message: string): string {
  return message.length <= MAX_CHAIN_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_CHAIN_MESSAGE_LENGTH - 1)}…`;
}

function failure(code: ChainErrorCode, message: string): { ok: false; error: ChainError } {
  return { ok: false, error: { code, message: bound(message) } };
}
