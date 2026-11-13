import type { WaitSpec } from "./spec.ts";

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Short label of one wait. Static text on purpose: T3 stores each status change. */
export function waitLabel(spec: WaitSpec, startedAt: number): string {
  switch (spec.event) {
    case "time":
      return `⏰${hhmm(startedAt + spec.afterMs)}`;
    case "process.exit":
      return `${spec.label} exit`;
    case "http.ready":
      return `${spec.url.replace(/^https?:\/\//, "").replace(/\/$/, "")} up`;
    default: {
      const n = spec.pr.match(/\/pull\/(\d+)$/)?.[1] ?? "?";
      const what = spec.event.slice(3);
      return `PR#${n} ${spec.reviewer ? `${what}:${spec.reviewer}` : what}`;
    }
  }
}

/** Banner text, or undefined when nothing waits. Count first: T3 cuts the one-line banner. */
export function statusLine(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return `⏳ ${labels.length} ${labels.length > 1 ? "waits" : "wait"}: ${labels.join(", ")}`;
}
