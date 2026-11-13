import { expect, test } from "bun:test";
import type { Verdict } from "./conditions.ts";
import { MAX_FAILURES, sleep, waitUntil } from "./until.ts";

const instant = { sleep: async () => {} };

test("returns the message of the first done verdict and checks no more", async () => {
  let calls = 0;
  const out = await waitUntil(
    async () => (++calls < 3 ? { done: false } : { done: true, message: "ok" }),
    instant,
    new AbortController().signal,
  );
  expect(out).toEqual({ kind: "done", message: "ok" });
  expect(calls).toBe(3);
});

test("uses the retry delay of the verdict", async () => {
  const delays: number[] = [];
  let n = 0;
  await waitUntil(
    async (): Promise<Verdict> =>
      ++n < 3 ? { done: false, retryInMs: 123 } : { done: true, message: "" },
    { sleep: async (ms) => void delays.push(ms) },
    new AbortController().signal,
  );
  expect(delays).toEqual([123, 123]);
});

test("an abort during the sleep cancels the wait", async () => {
  const ctl = new AbortController();
  const p = waitUntil(async () => ({ done: false, retryInMs: 60_000 }), { sleep }, ctl.signal);
  setTimeout(() => ctl.abort(), 10);
  expect(await p).toEqual({ kind: "cancelled" });
});

test("an abort during a check cancels, even when the check then says done", async () => {
  const ctl = new AbortController();
  const out = await waitUntil(
    async () => {
      ctl.abort();
      return { done: true, message: "late" };
    },
    instant,
    ctl.signal,
  );
  expect(out).toEqual({ kind: "cancelled" });
});

test("a signal that is already aborted never runs the check", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let calls = 0;
  const out = await waitUntil(async () => (++calls, { done: false }), instant, ctl.signal);
  expect(out).toEqual({ kind: "cancelled" });
  expect(calls).toBe(0);
});

test("failures back off, and a success resets the count", async () => {
  const delays: number[] = [];
  let n = 0;
  const out = await waitUntil(
    async (): Promise<Verdict> => {
      n++;
      if (n <= MAX_FAILURES - 1) throw new Error("net");
      if (n === MAX_FAILURES) return { done: false, retryInMs: 1 };
      if (n < 2 * MAX_FAILURES) throw new Error("net");
      return { done: true, message: "ok" };
    },
    { sleep: async (ms) => void delays.push(ms) },
    new AbortController().signal,
  );
  expect(out.kind).toBe("done");
  expect(delays[1]!).toBeGreaterThan(delays[0]!);
});

test("MAX_FAILURES failures in a row end the wait with an error", async () => {
  let calls = 0;
  const out = await waitUntil(
    async () => {
      calls++;
      throw new Error("gh: rate limit");
    },
    instant,
    new AbortController().signal,
  );
  expect(calls).toBe(MAX_FAILURES);
  expect(out).toMatchObject({ kind: "error" });
  expect(out.kind === "error" && out.message).toContain("rate limit");
});
