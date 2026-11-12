import { expect, test } from "bun:test";
import { AnchorTracker, boundBytes, readNotFoundHint, similarNames, type Fs } from "./hints.ts";

const fsOf = (tree: Record<string, string[]>): Fs => ({
  exists: (p) =>
    p in tree ||
    Object.values(tree).some((l, i) => l.some((n) => `${Object.keys(tree)[i]}/${n}` === p)),
  list: (d) => tree[d] ?? [],
});

test("similarNames finds case and extension variants, at most 3", () => {
  expect(similarNames("Foo.ts", ["foo.ts", "foo.tsx", "bar.md"])).toEqual(["foo.ts", "foo.tsx"]);
  expect(similarNames("a.ts", ["a1.ts", "a2.ts", "a3.ts", "a4.ts", "a5.ts"]).length).toBe(3);
  expect(similarNames("config.ts", ["README.md", "zzzzzzzz"])).toEqual([]);
});

test("similarNames scans at most 200 entries", () => {
  const entries = Array.from({ length: 300 }, (_, i) => `zz${i}.md`);
  entries[250] = "target.ts";
  expect(similarNames("targt.ts", entries)).toEqual([]);
});

test("read hint: missing image gives the parallel-call hint", () => {
  const h = readNotFoundHint("/tmp/shot.png", "/work", fsOf({ "/tmp": [] }));
  expect(h?.kind).toBe("image-missing");
  expect(h?.text).toContain("parallel");
});

test("read hint: similar name in the same directory", () => {
  const h = readNotFoundHint(
    "src/util.ts",
    "/work",
    fsOf({ "/work/src": ["utils.ts", "index.ts"] }),
  );
  expect(h?.kind).toBe("similar-name");
  expect(h?.text).toContain("utils.ts");
  expect(h?.text).not.toContain("index.ts");
});

test("read hint: directory exists but nothing similar", () => {
  const h = readNotFoundHint("src/zzz.ts", "/work", fsOf({ "/work/src": ["index.ts"] }));
  expect(h?.kind).toBe("dir-no-match");
});

test("read hint: missing directory names the nearest existing one", () => {
  const h = readNotFoundHint("/work/gone/deep/a.ts", "/work", fsOf({ "/work": ["x"] }));
  expect(h?.kind).toBe("dir-missing");
  expect(h?.text).toContain("/work");
});

test("read hint: removed worktree path is named", () => {
  const h = readNotFoundHint("/data/.t3/worktrees/app/t3-1/a.ts", "/", fsOf({ "/data": [] }));
  expect(h?.text).toContain("removed worktree");
});

test("read hint: silent when the file exists, and never throws", () => {
  expect(readNotFoundHint("a.ts", "/work", fsOf({ "/work": ["a.ts"] }))).toBeUndefined();
  const bad: Fs = {
    exists: () => {
      throw new Error("boom");
    },
    list: () => [],
  };
  expect(readNotFoundHint("a.ts", "/work", bad)).toBeUndefined();
});

test("boundBytes keeps hints under 400 bytes, also with multibyte text", () => {
  const out = boundBytes("é".repeat(500));
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(400);
  expect(
    readNotFoundHint(`/w/${"d".repeat(900)}/x.ts`, "/", fsOf({ "/w": [] }))!.text.length,
  ).toBeLessThan(401);
});

const STALE = (refs: string) =>
  `[E_STALE_ANCHOR] 1 stale anchor: ${refs}. Re-read the file to get current anchors.`;

test("edit hint: malformed ref", () => {
  const t = new AnchorTracker();
  const h = t.hintFor(
    "/w/a.ts",
    '[E_BAD_REF] Invalid line reference "14#??": hash uses invalid characters',
  );
  expect(h?.kind).toBe("malformed-ref");
});

test("edit hint: anchor never shown by a read", () => {
  const t = new AnchorTracker();
  t.onResult("read", "/w/a.ts", false, "  1#ZP:a\n  2#MQ:b");
  const h = t.hintFor("/w/a.ts", STALE("391#TR"));
  expect(h?.kind).toBe("never-shown");
  expect(h?.text).toContain("391#TR");
});

test("edit hint: anchor shown, file unchanged by us -> changed-since-read", () => {
  const t = new AnchorTracker();
  t.onResult("read", "/w/a.ts", false, "  7#ZP:a");
  expect(t.hintFor("/w/a.ts", STALE("7#ZP"))?.kind).toBe("changed-since-read");
});

test("edit hint: own earlier edit after read", () => {
  const t = new AnchorTracker();
  t.onResult("read", "/w/a.ts", false, "  7#ZP:a");
  t.onResult("edit", "/w/a.ts", false, "Updated");
  expect(t.hintFor("/w/a.ts", STALE("7#ZP"))?.kind).toBe("edited-since-read");
  t.onResult("read", "/w/a.ts", false, "  7#ZP:a");
  expect(t.hintFor("/w/a.ts", STALE("7#ZP"))?.kind).toBe("changed-since-read");
});

test("edit hint: anchors of another file do not count as shown", () => {
  const t = new AnchorTracker();
  t.onResult("read", "/w/b.ts", false, "  7#ZP:a");
  expect(t.hintFor("/w/a.ts", STALE("7#ZP"))?.kind).toBe("never-shown");
});

test("edit hint: unrelated errors and failed reads add nothing", () => {
  const t = new AnchorTracker();
  expect(t.hintFor("/w/a.ts", "[E_WOULD_EMPTY] nope")).toBeUndefined();
  t.onResult("read", "/w/a.ts", true, "  7#ZP:a");
  expect(t.hintFor("/w/a.ts", STALE("7#ZP"))?.kind).toBe("never-shown");
});
