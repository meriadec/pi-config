import type { WaitSpec } from "./spec.ts";

/** T3 primitives the router may use. Real code binds these to the T3 MCP tools; mocks record calls. */
export interface T3Ports {
  watchPullRequest(url: string): Promise<void>;
  scheduleOnce(runAtIso: string, prompt: string): Promise<void>;
  /** Wake an idle thread with a message. */
  sendToThread(message: string): Promise<void>;
}

export type Route =
  | { via: "t3.watch_pull_request" }
  | { via: "t3.schedule_task" }
  | { via: "local-runner"; poller: "pid" | "http" | "timer" };

/**
 * Timers at or above this go to T3 on purpose: T3 keeps them when Pi restarts.
 * T3 accepts shorter `once` runs (tested at 25 s), so this is a choice, not a limit.
 */
export const MIN_T3_SCHEDULE_MS = 60_000;

export function chooseRoute(spec: WaitSpec): Route {
  switch (spec.event) {
    case "pr.review":
    case "pr.checks":
      return { via: "t3.watch_pull_request" };
    case "time":
      return spec.afterMs >= MIN_T3_SCHEDULE_MS
        ? { via: "t3.schedule_task" }
        : { via: "local-runner", poller: "timer" };
    case "process.exit":
      return { via: "local-runner", poller: "pid" };
    case "http.ready":
      return { via: "local-runner", poller: "http" };
  }
}

export async function registerWait(spec: WaitSpec, t3: T3Ports, now: () => number): Promise<Route> {
  const route = chooseRoute(spec);
  if (route.via === "t3.watch_pull_request" && "pr" in spec) await t3.watchPullRequest(spec.pr);
  if (route.via === "t3.schedule_task" && spec.event === "time") {
    await t3.scheduleOnce(
      new Date(now() + spec.afterMs).toISOString(),
      "The wait you asked for is over.",
    );
  }
  return route;
}
