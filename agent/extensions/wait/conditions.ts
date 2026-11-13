import type { WaitSpec } from "./spec.ts";

/** One poll of one condition. Pure logic: all I/O comes in through `ConditionDeps`. */

export type Verdict = { done: false; retryInMs?: number } | { done: true; message: string };

/** The part of `gh pr view --json …` that the conditions read. */
export interface PrView {
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt?: string | null;
  mergeCommit?: { oid: string } | null;
  statusCheckRollup?: readonly CheckItem[] | null;
  reviews?: readonly Review[] | null;
  latestReviews?: readonly Review[] | null;
  comments?: readonly Comment[] | null;
}
export interface CheckItem {
  name?: string;
  context?: string;
  /** CheckRun */
  status?: string;
  conclusion?: string;
  /** StatusContext */
  state?: string;
}
export interface Review {
  id: string;
  state: string;
  author?: { login?: string } | null;
}
export interface Comment {
  id: string;
  author?: { login?: string } | null;
}

export interface ConditionDeps {
  now(): number;
  prView(url: string, fields: string[], signal?: AbortSignal): Promise<PrView>;
  isAlive(pid: number): boolean;
  probeHttp(url: string): Promise<boolean>;
}

/** The spec of a wait, with a process `match` already resolved to a pid. */
export type ResolvedSpec = Exclude<WaitSpec, { event: "process.exit" }> | ProcessSpec;
export interface ProcessSpec {
  event: "process.exit";
  label: string;
  pid: number;
}

export const PR_POLL_MS = 30_000;
export const LOCAL_POLL_MS = 2_000;
/** A PR with no check at all counts as "done" only after this time: checks may not exist yet. */
export const NO_CHECKS_GRACE_MS = 2 * 60_000;

export const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

const by = (reviewer: string | undefined) => (x: { author?: { login?: string } | null }) =>
  reviewer === undefined || (x.author?.login ?? "").toLowerCase().includes(reviewer.toLowerCase());

function isPending(c: CheckItem): boolean {
  if (c.status !== undefined) return c.status !== "COMPLETED";
  return c.state === "PENDING" || c.state === "EXPECTED";
}

function isFailed(c: CheckItem): boolean {
  if (c.status !== undefined)
    return (
      c.status === "COMPLETED" && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion ?? "")
    );
  return c.state === "FAILURE" || c.state === "ERROR";
}

/** Fields that `gh pr view --json` must return for this spec. */
export function fieldsFor(spec: ResolvedSpec): string[] {
  switch (spec.event) {
    case "pr.merged":
      return ["state", "mergedAt", "mergeCommit"];
    case "pr.checks.done":
      return ["state", "statusCheckRollup"];
    case "pr.review":
      return ["state", "reviews", "comments"];
    case "pr.approved":
      return ["state", "latestReviews"];
    default:
      return [];
  }
}

/** Make the check function of one wait. It may keep a baseline between polls. */
export function makeCheck(
  spec: ResolvedSpec,
  deps: ConditionDeps,
): (signal?: AbortSignal) => Promise<Verdict> {
  const startedAt = deps.now();
  const age = () => minutes(deps.now() - startedAt);

  switch (spec.event) {
    case "time":
      return async () => {
        const left = startedAt + spec.afterMs - deps.now();
        return left <= 0
          ? { done: true, message: `Timer of ${minutes(spec.afterMs)} is over.` }
          : { done: false, retryInMs: Math.min(left, PR_POLL_MS) };
      };
    case "process.exit":
      return async () =>
        deps.isAlive(spec.pid)
          ? { done: false, retryInMs: LOCAL_POLL_MS }
          : {
              done: true,
              message: `Process ${spec.label} (pid ${spec.pid}) exited after ${age()}.`,
            };
    case "http.ready":
      return async () =>
        (await deps.probeHttp(spec.url))
          ? { done: true, message: `${spec.url} answers after ${age()}.` }
          : { done: false, retryInMs: LOCAL_POLL_MS };
  }

  const url = spec.pr;
  const fields = fieldsFor(spec);
  const closedEarly = (v: PrView): Verdict | undefined =>
    v.state === "OPEN" || spec.event === "pr.merged"
      ? undefined
      : {
          done: true,
          message: `PR ${url} is ${v.state.toLowerCase()}, so ${spec.event} cannot happen any more.`,
        };
  const keep: Verdict = { done: false, retryInMs: PR_POLL_MS };

  switch (spec.event) {
    case "pr.merged":
      return async (signal) => {
        const v = await deps.prView(url, fields, signal);
        if (v.state === "MERGED") {
          const sha = v.mergeCommit?.oid ? ` Merge commit ${v.mergeCommit.oid}.` : "";
          return {
            done: true,
            message: `PR ${url} was merged${v.mergedAt ? ` at ${v.mergedAt}` : ""}.${sha}`,
          };
        }
        if (v.state === "CLOSED")
          return { done: true, message: `PR ${url} was closed WITHOUT merge after ${age()}.` };
        return keep;
      };
    case "pr.checks.done":
      return async (signal) => {
        const v = await deps.prView(url, fields, signal);
        const early = closedEarly(v);
        if (early) return early;
        const checks = v.statusCheckRollup ?? [];
        if (checks.length === 0 && deps.now() - startedAt < NO_CHECKS_GRACE_MS) return keep;
        if (checks.some(isPending)) return keep;
        const failed = checks.filter(isFailed).map((c) => c.name ?? c.context ?? "?");
        return {
          done: true,
          message:
            failed.length === 0
              ? `All ${checks.length} checks of ${url} are done and none failed.`
              : `Checks of ${url} are done. ${failed.length} failed: ${failed.join(", ")}.`,
        };
      };
    case "pr.review": {
      const mine = by(spec.reviewer);
      let known: Set<string> | undefined;
      const who = spec.reviewer ? ` from ${spec.reviewer}` : "";
      return async (signal) => {
        const v = await deps.prView(url, fields, signal);
        const early = closedEarly(v);
        if (early) return early;
        const items = [
          ...(v.reviews ?? [])
            .filter((r) => r.state !== "PENDING")
            .map((r) => ({ ...r, kind: "review" })),
          ...(v.comments ?? []).map((c) => ({ ...c, kind: "comment" })),
        ].filter(mine);
        if (!known) {
          known = new Set(items.map((i) => i.id)); // baseline: what exists when the wait starts
          return keep;
        }
        const fresh = items.filter((i) => !known!.has(i.id));
        if (fresh.length === 0) return keep;
        const list = fresh.map((i) => `${i.kind} by ${i.author?.login ?? "?"}`).join(", ");
        return {
          done: true,
          message: `New activity${who} on ${url} after ${age()}: ${list}. Read it with gh.`,
        };
      };
    }
    case "pr.approved":
      return async (signal) => {
        const v = await deps.prView(url, fields, signal);
        const early = closedEarly(v);
        if (early) return early;
        const ok = (v.latestReviews ?? []).find(
          (r) => r.state === "APPROVED" && by(spec.reviewer)(r),
        );
        return ok
          ? {
              done: true,
              message: `${url} is approved by ${ok.author?.login ?? "?"} after ${age()}.`,
            }
          : keep;
      };
  }
}
