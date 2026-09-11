import { describe, expect, test } from "bun:test";
import { planPartitionMove, type PartitionMember } from "./partition.ts";

function layout(...partitions: readonly (readonly string[])[]): PartitionMember[] {
  return partitions.flatMap((ids, partition) => ids.map((id) => ({ id, partition })));
}

function result(
  topics: readonly PartitionMember[],
  familyIds: readonly string[],
  selectedId: string,
  direction: "up" | "down",
): Array<[string, number]> | undefined {
  const plan = planPartitionMove(topics, new Set(familyIds), selectedId, direction);
  return plan === undefined ? undefined : [...plan.entries()];
}

describe("Partition movement", () => {
  test("extracts a family into an intermediate Partition before merging it upward", () => {
    const topics = layout(["a", "b", "c"], ["d", "e"]);
    const extracted = result(topics, ["e"], "e", "up");
    expect(extracted).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["e", 1],
      ["d", 2],
    ]);

    const next = extracted!.map(([id, partition]) => ({ id, partition }));
    expect(result(next, ["e"], "e", "up")).toEqual([
      ["a", 0],
      ["b", 0],
      ["c", 0],
      ["e", 0],
      ["d", 1],
    ]);
  });

  test("extracts downward and creates outer Partitions", () => {
    expect(result(layout(["a", "b"], ["c"]), ["b"], "b", "down")).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(result(layout(["a", "b"]), ["a"], "a", "up")).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  test("moves a complete family and rejects movement past a lone outer Partition", () => {
    const topics = layout(["parent", "child", "other"]);
    expect(result(topics, ["parent", "child"], "child", "down")).toEqual([
      ["other", 0],
      ["parent", 1],
      ["child", 1],
    ]);

    expect(
      result(layout(["other"], ["parent", "child"]), ["parent", "child"], "parent", "down"),
    ).toBeUndefined();
  });

  test("normalizes sparse Partition numbers", () => {
    expect(
      result(
        [
          { id: "a", partition: -8 },
          { id: "b", partition: 12 },
        ],
        ["b"],
        "b",
        "up",
      ),
    ).toEqual([
      ["a", 0],
      ["b", 0],
    ]);
  });
});
