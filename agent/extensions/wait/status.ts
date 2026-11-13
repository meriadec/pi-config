import type { LocalWait } from "./runner.ts";

const hhmm = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Static text on purpose: T3 stores each status change, so a ticking clock would flood it.
function one(w: LocalWait): string {
  const s = w.spec;
  if (s.event === "time") return `timer until ${hhmm(w.createdAt + s.afterMs)}`;
  if (s.event === "process.exit") return `waiting for ${s.label} to exit`;
  return `waiting for ${s.url.replace(/^https?:\/\//, "")}`;
}

/** Footer text for active waits, or undefined when there are none. */
export function statusLine(local: LocalWait[], prWatches: number): string | undefined {
  const parts = local.slice(0, 3).map((w) => one(w));
  if (local.length > 3) parts.push(`+${local.length - 3}`);
  if (prWatches > 0) parts.push(`${prWatches} PR watch${prWatches > 1 ? "es" : ""}`);
  return parts.length ? `⏳ ${parts.join(" · ")}` : undefined;
}
