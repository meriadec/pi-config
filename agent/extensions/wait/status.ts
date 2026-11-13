import type { LocalWait } from "./runner.ts";

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 3600
    ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function one(w: LocalWait, now: number): string {
  const s = w.spec;
  if (s.event === "time") return `timer ${clock(w.createdAt + s.afterMs - now)}`;
  if (s.event === "process.exit") return `${s.label} exit ${clock(now - w.createdAt)}`;
  return `${s.url.replace(/^https?:\/\//, "")} ${clock(now - w.createdAt)}`;
}

/** Footer text for active waits, or undefined when there are none. */
export function statusLine(local: LocalWait[], prWatches: number, now: number): string | undefined {
  const parts = local.slice(0, 3).map((w) => one(w, now));
  if (local.length > 3) parts.push(`+${local.length - 3}`);
  if (prWatches > 0) parts.push(`${prWatches} PR watch${prWatches > 1 ? "es" : ""}`);
  return parts.length ? `⏳ ${parts.join(" · ")}` : undefined;
}
