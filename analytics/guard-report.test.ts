import { expect, test } from "bun:test";
import { formatGuardReport, summarizeGuard } from "./guard-report.ts";

const rec = (o: object) => JSON.stringify({ ts: "t", ...o });
const fixture = [
  rec({ rule: "cap", family: "git diff", cmdSha1: "a", removed: 3_000_000 }),
  rec({ rule: "cap", family: "git diff", cmdSha1: "b", removed: 1_000_000 }),
  rec({ rule: "cap", family: "rg -n", cmdSha1: "c", removed: 500_000 }),
  rec({ rule: "refetch", family: "git diff", cmdSha1: "a" }),
  rec({ rule: "refetch", family: "x", cmdSha1: "zzz" }),
  "not json",
  "",
].join("\n");

test("summarizeGuard counts rules, removed MB, top families and refetch rate", () => {
  const s = summarizeGuard(fixture);
  expect(s.perRule).toEqual({ cap: 3, refetch: 2 });
  expect(s.wouldRemoveMB).toBeCloseTo(4.5);
  expect(s.topFamilies[0]).toEqual({ family: "git diff", removedBytes: 4_000_000, caps: 2 });
  expect(s.topFamilies.map((f) => f.family)).toEqual(["git diff", "rg -n"]);
  const gd = s.refetch.find((f) => f.family === "git diff")!;
  expect(gd).toEqual({ family: "git diff", caps: 2, refetches: 1, rate: 0.5 });
  expect(s.refetch.find((f) => f.family === "rg -n")!.rate).toBe(0);
});

test("summarizeGuard keeps only the top 10 families", () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    rec({ rule: "cap", family: `f${i}`, cmdSha1: `h${i}`, removed: i + 1 }),
  ).join("\n");
  const s = summarizeGuard(many);
  expect(s.topFamilies.length).toBe(10);
  expect(s.topFamilies[0]!.family).toBe("f11");
});

test("summarizeGuard reports the quiet rule apart from the cap rule", () => {
  const s = summarizeGuard(
    [
      rec({ rule: "quiet", family: "bun test", removed: 2_000_000 }),
      rec({ rule: "quiet", family: "bun test", removed: 1_000_000 }),
      rec({ rule: "quiet", family: "pnpm lint", removed: 500_000 }),
      rec({ rule: "cap", family: "git diff", cmdSha1: "a", removed: 100 }),
    ].join("\n"),
  );
  expect(s.quiet.records).toBe(3);
  expect(s.quiet.removedMB).toBeCloseTo(3.5);
  expect(s.quiet.topFamilies[0]).toEqual({
    family: "bun test",
    removedBytes: 3_000_000,
    records: 2,
  });
  expect(s.wouldRemoveMB).toBeCloseTo(0.0001);
  expect(formatGuardReport(s)).toContain("Quiet rule: 3 records, 3.50 MB removed");
});

test("summarizeGuard reports the reread rule: records, KB saved, top names", () => {
  const s = summarizeGuard(
    [
      rec({ rule: "reread", path_ext: "AGENTS.md", bytes: 4000 }),
      rec({ rule: "reread", path_ext: "AGENTS.md", bytes: 4000 }),
      rec({ rule: "reread", path_ext: ".ts", bytes: 2500 }),
      rec({ rule: "cap", family: "git diff", cmdSha1: "a", removed: 100 }),
    ].join("\n"),
  );
  expect(s.reread.records).toBe(3);
  expect(s.reread.savedKB).toBeCloseTo(10.5);
  expect(s.reread.top).toEqual([
    { name: "AGENTS.md", records: 2, bytes: 8000 },
    { name: ".ts", records: 1, bytes: 2500 },
  ]);
  expect(s.wouldRemoveMB).toBeCloseTo(0.0001);
  expect(formatGuardReport(s)).toContain("Reread rule: 3 records, 10.5 KB would be saved");
});
