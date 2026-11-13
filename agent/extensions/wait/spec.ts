/** What an agent can ask to wait for. The agent says WHAT, never HOW. */
export type WaitSpec =
  | { event: "pr.review" | "pr.checks"; pr: string }
  | { event: "time"; afterMs: number }
  | { event: "process.exit"; label: string; pid?: number; match?: string }
  | { event: "http.ready"; url: string };

export type WaitEventName = WaitSpec["event"];

const stringOr = (v: unknown, fallback: string) =>
  typeof v === "string" && v !== "" ? v : fallback;

export function parseWaitSpec(input: unknown): WaitSpec {
  if (typeof input !== "object" || input === null) throw new Error("wait spec must be an object");
  const o = input as {
    event?: unknown;
    pr?: unknown;
    afterMs?: unknown;
    pid?: unknown;
    label?: unknown;
    match?: unknown;
    url?: unknown;
  };
  switch (o.event) {
    case "pr.review":
    case "pr.checks":
      if (
        typeof o.pr !== "string" ||
        !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(o.pr)
      ) {
        throw new Error("pr must be a full GitHub pull request URL");
      }
      return { event: o.event, pr: o.pr };
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
