import { expect, test } from "bun:test";
import {
  type ConditionDeps,
  makeCheck,
  NO_CHECKS_GRACE_MS,
  type PrView,
  type ResolvedSpec,
} from "./conditions.ts";

const PR = "https://github.com/o/r/pull/7";

function setup(spec: ResolvedSpec, views: PrView[] = []) {
  let now = 1_000;
  let alive = true;
  let http = false;
  let i = 0;
  const asked: string[][] = [];
  const deps: ConditionDeps = {
    now: () => now,
    prView: async (_url, fields) => {
      asked.push(fields);
      return views[Math.min(i++, views.length - 1)]!;
    },
    isAlive: () => alive,
    probeHttp: async () => http,
  };
  return {
    check: makeCheck(spec, deps),
    asked,
    advance: (ms: number) => void (now += ms),
    kill: () => void (alive = false),
    serve: () => void (http = true),
  };
}

test("pr.merged waits while open, then reports the merge commit", async () => {
  const h = setup({ event: "pr.merged", pr: PR }, [
    { state: "OPEN" },
    { state: "MERGED", mergedAt: "T1", mergeCommit: { oid: "abc" } },
  ]);
  expect((await h.check()).done).toBe(false);
  const v = await h.check();
  expect(v).toMatchObject({ done: true });
  expect(v.done && v.message).toContain("merged");
  expect(v.done && v.message).toContain("abc");
  expect(h.asked[0]).toEqual(["state", "mergedAt", "mergeCommit"]);
});

test("pr.merged also ends when the PR is closed, and says WITHOUT merge", async () => {
  const h = setup({ event: "pr.merged", pr: PR }, [{ state: "CLOSED" }]);
  const v = await h.check();
  expect(v.done && v.message).toContain("WITHOUT merge");
});

test("pr.checks.done waits for pending checks of both kinds, then lists failures", async () => {
  const h = setup({ event: "pr.checks.done", pr: PR }, [
    { state: "OPEN", statusCheckRollup: [{ name: "a", status: "IN_PROGRESS" }] },
    { state: "OPEN", statusCheckRollup: [{ context: "ci", state: "PENDING" }] },
    {
      state: "OPEN",
      statusCheckRollup: [
        { name: "a", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
        { context: "ci", state: "ERROR" },
      ],
    },
  ]);
  expect((await h.check()).done).toBe(false);
  expect((await h.check()).done).toBe(false);
  const v = await h.check();
  expect(v.done && v.message).toContain("2 failed: lint, ci");
});

test("pr.checks.done: no check at all is not done until the grace time passes", async () => {
  const h = setup({ event: "pr.checks.done", pr: PR }, [{ state: "OPEN", statusCheckRollup: [] }]);
  expect((await h.check()).done).toBe(false);
  h.advance(NO_CHECKS_GRACE_MS);
  expect((await h.check()).done).toBe(true);
});

test("pr.review ignores what existed at the start and fires on new reviews or comments", async () => {
  const old = { id: "r0", state: "COMMENTED", author: { login: "alice" } };
  const h = setup({ event: "pr.review", pr: PR }, [
    { state: "OPEN", reviews: [old], comments: [] },
    { state: "OPEN", reviews: [old, { id: "r1", state: "PENDING" }], comments: [] },
    { state: "OPEN", reviews: [old], comments: [{ id: "c1", author: { login: "bob" } }] },
  ]);
  expect((await h.check()).done).toBe(false); // baseline
  expect((await h.check()).done).toBe(false); // pending review is not a review
  const v = await h.check();
  expect(v.done && v.message).toContain("comment by bob");
});

test("pr.review with a reviewer matches the login in part and ignores others", async () => {
  const h = setup({ event: "pr.review", pr: PR, reviewer: "copilot" }, [
    { state: "OPEN", reviews: [], comments: [] },
    {
      state: "OPEN",
      reviews: [{ id: "r1", state: "COMMENTED", author: { login: "alice" } }],
      comments: [],
    },
    {
      state: "OPEN",
      reviews: [
        { id: "r1", state: "COMMENTED", author: { login: "alice" } },
        { id: "r2", state: "COMMENTED", author: { login: "copilot-pull-request-reviewer" } },
      ],
      comments: [],
    },
  ]);
  await h.check();
  expect((await h.check()).done).toBe(false);
  const v = await h.check();
  expect(v.done && v.message).toContain("copilot-pull-request-reviewer");
});

test("pr.approved needs an APPROVED latest review, from the reviewer when one is given", async () => {
  const h = setup({ event: "pr.approved", pr: PR, reviewer: "bob" }, [
    { state: "OPEN", latestReviews: [{ id: "1", state: "APPROVED", author: { login: "alice" } }] },
    { state: "OPEN", latestReviews: [{ id: "2", state: "APPROVED", author: { login: "bob" } }] },
  ]);
  expect((await h.check()).done).toBe(false);
  expect((await h.check()).done).toBe(true);
});

test("a PR review wait on a merged PR ends at once and says why", async () => {
  const h = setup({ event: "pr.review", pr: PR }, [{ state: "MERGED" }]);
  const v = await h.check();
  expect(v.done && v.message).toContain("cannot happen any more");
});

test("time, process and http conditions", async () => {
  const t = setup({ event: "time", afterMs: 5_000 });
  expect((await t.check()).done).toBe(false);
  t.advance(5_000);
  expect((await t.check()).done).toBe(true);

  const p = setup({ event: "process.exit", label: "vite", pid: 4 });
  expect((await p.check()).done).toBe(false);
  p.kill();
  const pv = await p.check();
  expect(pv.done && pv.message).toContain("vite");

  const u = setup({ event: "http.ready", url: "http://x" });
  expect((await u.check()).done).toBe(false);
  u.serve();
  expect((await u.check()).done).toBe(true);
});
