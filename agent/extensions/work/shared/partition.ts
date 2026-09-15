export type PartitionDirection = "up" | "down";

export interface PartitionMember {
  id: string;
  partition: number;
}

/**
 * Plans one visible Partition step for a complete Topic family.
 *
 * A family that shares its Partition is extracted into a new adjacent Partition. A family that is
 * already alone merges into the adjacent Partition. Returned Partition numbers are normalized to
 * consecutive integers; undefined means that the requested outer move cannot change the layout.
 */
export function planPartitionMove(
  topics: readonly PartitionMember[],
  familyIds: ReadonlySet<string>,
  selectedId: string,
  direction: PartitionDirection,
): ReadonlyMap<string, number> | undefined {
  const selected = topics.find((topic) => topic.id === selectedId);
  if (selected === undefined) return undefined;

  const movingIds = topics.filter((topic) => familyIds.has(topic.id)).map((topic) => topic.id);
  if (movingIds.length === 0 || movingIds.length === topics.length) return undefined;

  const groups = [...new Set(topics.map((topic) => topic.partition))]
    .toSorted((left, right) => left - right)
    .map((partition) => ({
      partition,
      ids: topics
        .filter((topic) => topic.partition === partition && !familyIds.has(topic.id))
        .map((topic) => topic.id),
    }));
  const sourceIndex = groups.findIndex((group) => group.partition === selected.partition);
  if (sourceIndex < 0) return undefined;

  const source = groups[sourceIndex]!;
  if (source.ids.length > 0) {
    groups.splice(direction === "up" ? sourceIndex : sourceIndex + 1, 0, {
      partition: selected.partition,
      ids: movingIds,
    });
  } else {
    const targetIndex = sourceIndex + (direction === "up" ? -1 : 1);
    if (groups[targetIndex] === undefined) return undefined;
    groups.splice(sourceIndex, 1);
    const adjustedTarget = direction === "up" ? targetIndex : targetIndex - 1;
    groups[adjustedTarget]!.ids.push(...movingIds);
  }

  return new Map(groups.flatMap((group, partition) => group.ids.map((id) => [id, partition])));
}
