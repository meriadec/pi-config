import { expect, test } from "bun:test";
import { summarizeGuard } from "./guard-report.ts";

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
