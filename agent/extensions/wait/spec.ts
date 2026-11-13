/** What an agent can ask to wait for. The agent says WHAT, never HOW. */
export type PrEvent = "pr.merged" | "pr.checks.done" | "pr.review" | "pr.approved";

export type WaitSpec =
  | { event: PrEvent; pr: string; reviewer?: string }
  | { event: "time"; afterMs: number }
  | { event: "process.exit"; label: string; pid?: number; match?: string }
  | { event: "http.ready"; url: string };

export type WaitEventName = WaitSpec["event"];

const PR_EVENTS: readonly string[] = ["pr.merged", "pr.checks.done", "pr.review", "pr.approved"];
const PR_URL = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

const stringOr = (v: unknown, fallback: string) =>
  typeof v === "string" && v !== "" ? v : fallback;

export function parseWaitSpec(input: unknown): WaitSpec {
  if (typeof input !== "object" || input === null) throw new Error("wait spec must be an object");
  const o = input as {
    event?: unknown;
    pr?: unknown;
    reviewer?: unknown;
    afterMs?: unknown;
    pid?: unknown;
    label?: unknown;
    match?: unknown;
    url?: unknown;
  };
  if (typeof o.event === "string" && PR_EVENTS.includes(o.event)) {
    if (typeof o.pr !== "string" || !PR_URL.test(o.pr))
      throw new Error("pr must be a full GitHub pull request URL");
    const event = o.event as PrEvent;
    if (typeof o.reviewer === "string" && o.reviewer.trim() !== "") {
      if (event !== "pr.review" && event !== "pr.approved")
        throw new Error("reviewer is only for pr.review and pr.approved");
      return { event, pr: o.pr, reviewer: o.reviewer.trim() };
    }
    return { event, pr: o.pr };
  }
  switch (o.event) {
    case "time":
      if (typeof o.afterMs !== "number" || !(o.afterMs > 0)) throw new Error("afterMs must be > 0");
      return { event: "time", afterMs: o.afterMs };
    case "process.exit":
      if (typeof o.pid === "number" && typeof o.match === "string")
        throw new Error("give pid or match, not both");
      if (typeof o.pid === "number") {
        return { event: "process.exit", label: stringOr(o.label, `pid ${o.pid}`), pid: o.pid };
      }
      if (typeof o.match === "string" && o.match.trim() !== "") {
        return { event: "process.exit", label: stringOr(o.label, o.match), match: o.match };
      }
      throw new Error("process.exit needs pid or match");
    case "http.ready":
      if (typeof o.url !== "string" || !/^https?:\/\//.test(o.url))
        throw new Error("url must be http(s)");
      return { event: "http.ready", url: o.url };
    default:
      throw new Error(`unknown event: ${String(o.event)}`);
  }
}
