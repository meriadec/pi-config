import type { WaitSpec } from "./spec.ts";

/** T3 primitives the router may use. Real code binds these to the T3 MCP tools; mocks record calls. */
export interface T3Ports {
  watchPullRequest(url: string): Promise<void>;
  /** Wake an idle thread with a message. */
  sendToThread(message: string): Promise<void>;
}

export type Route =
  | { via: "t3.watch_pull_request" }
  | { via: "local-runner"; poller: "pid" | "http" | "timer" };

// Timers stay local on purpose: T3 `schedule_task` makes a global automation that never goes away.

export function chooseRoute(spec: WaitSpec): Route {
  switch (spec.event) {
    case "pr.review":
    case "pr.checks":
      return { via: "t3.watch_pull_request" };
    case "time":
      return { via: "local-runner", poller: "timer" };
    case "process.exit":
      return { via: "local-runner", poller: "pid" };
    case "http.ready":
      return { via: "local-runner", poller: "http" };
  }
}

export async function registerWait(spec: WaitSpec, t3: T3Ports): Promise<Route> {
  const route = chooseRoute(spec);
  if (route.via === "t3.watch_pull_request" && "pr" in spec) await t3.watchPullRequest(spec.pr);
  return route;
}
