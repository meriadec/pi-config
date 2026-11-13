import type { LocalWait } from "./runner.ts";

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Static text on purpose: T3 stores each status change, so a ticking clock would flood it.
// Short items: T3 shows the banner on ONE line and cuts it, so the count comes first and
// every wait must stay small.
function one(w: LocalWait): string {
  const s = w.spec;
  if (s.event === "time") return `⏰${hhmm(w.createdAt + s.afterMs)}`;
  if (s.event === "process.exit") return `${s.label} exit`;
  return `${s.url.replace(/^https?:\/\//, "").replace(/\/$/, "")} up`;
}

/** Banner text for active waits, or undefined when there are none. */
export function statusLine(local: LocalWait[], prWatches: number): string | undefined {
  const total = local.length + prWatches;
  if (total === 0) return undefined;
  const items = local.map(one);
  if (prWatches > 0) items.push(prWatches > 1 ? `${prWatches} PRs` : "PR");
  return `⏳ ${total} ${total > 1 ? "waits" : "wait"}: ${items.join(", ")}`;
}
