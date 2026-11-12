import { expect, test } from "bun:test";
import {
  bashMayWrite,
  findRereads,
  parseTs,
  summarizeRereads,
  type RereadEvent,
} from "./rereads.ts";

const read = (ts: number, path: string, size = 5000, turn = ts, slice = ":"): RereadEvent => ({
  kind: "read",
  file: "s",
  ts,
  turn,
  path,
  slice,
  size,
});
const one = (events: RereadEvent[], nearTurns?: number) => findRereads(events, { nearTurns });

test("same slice repeat is a reread; other slice is not", () => {
  expect(one([read(1, "/a.ts"), read(2, "/a.ts")]).length).toBe(1);
  expect(one([read(1, "/a.ts"), read(2, "/a.ts", 5000, 2, "1:5")]).length).toBe(0);
});

test("edit or write of the path between reads removes it; other path does not", () => {
  expect(
    one([read(1, "/a.ts"), { kind: "write", file: "s", ts: 2, path: "/a.ts" }, read(3, "/a.ts")])
      .length,
  ).toBe(0);
  expect(
    one([read(1, "/a.ts"), { kind: "write", file: "s", ts: 2, path: "/b.ts" }, read(3, "/a.ts")])
      .length,
  ).toBe(1);
});

test("causes: image, compaction, small, docs, near, far", () => {
  const c = (p: string, size: number, gap: number, extra: RereadEvent[] = []) =>
    one([read(10, p, size, 1), ...extra, read(20, p, size, 1 + gap)], 5)[0]!.cause;
  expect(c("/x.png", 5000, 1)).toBe("image");
  expect(c("/a.ts", 5000, 1, [{ kind: "compaction", file: "s", ts: 15 }])).toBe("after_compaction");
  expect(c("/a.ts", 100, 1)).toBe("small");
  expect(c("/docs/x.md", 5000, 1)).toBe("repo_docs");
  expect(c("/a.ts", 5000, 5)).toBe("near");
  expect(c("/a.ts", 5000, 6)).toBe("far");
});

test("savings skip images and compaction, subtract stub, flag bash risk", () => {
  const rr = [
    ...one([read(1, "/a.ts", 1000), read(2, "/a.ts", 1000)]),
    ...one([read(1, "/p.png", 9000), read(2, "/p.png", 9000)]),
    ...one([
      read(1, "/b.ts", 1000),
      { kind: "bash", file: "s", ts: 2, command: "sed -i s/a/b/ b.ts" },
      read(3, "/b.ts", 1000),
    ]),
  ];
  const s = summarizeRereads(rr, 100000, 80);
  expect(s.total.count).toBe(3);
  expect(s.saved).toEqual({ count: 2, bytes: 1840 });
  expect(s.savedNoBashRisk).toEqual({ count: 1, bytes: 920 });
});

test("bash write heuristic", () => {
  expect(bashMayWrite("echo hi > f")).toBe(true);
  expect(bashMayWrite("git checkout main")).toBe(true);
  expect(bashMayWrite("ls -la")).toBe(false);
});

test("timestamps from DuckDB and JSONL agree", () => {
  expect(parseTs("2026-11-11 15:18:51.129")).toBe(parseTs("2026-11-11T15:18:51.129Z"));
});
