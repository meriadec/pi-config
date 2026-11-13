import { type ConditionDeps, makeCheck, type ResolvedSpec } from "./conditions.ts";
import type { ActiveWaits } from "./active.ts";
import { pickByMatch, type TaggedProcess } from "./procscan.ts";
import { parseWaitSpec } from "./spec.ts";
import { waitLabel } from "./status.ts";
import { type UntilDeps, waitUntil } from "./until.ts";

/** What `wait_for`, `wait_list` and `wait_cancel` do. Pure logic: all I/O comes in through `WaitEnv`. */

export interface WaitEnv {
  conditions: ConditionDeps;
  until: UntilDeps;
  active: ActiveWaits;
  findTagged(): Promise<TaggedProcess[]>;
  /** Called when the set of active waits changes (status banner). */
  onChange(): void;
}

export interface ToolText {
  content: [{ type: "text"; text: string }];
  details: { id?: string; error?: string; outcome?: "done" | "cancelled" | "error" };
  isError: boolean;
}

const text = (t: string, details: ToolText["details"] = {}, isError = false): ToolText => ({
  content: [{ type: "text", text: t }],
  details,
  isError,
});

export async function executeWait(
  input: unknown,
  env: WaitEnv,
  signal?: AbortSignal,
): Promise<ToolText> {
  let spec: ReturnType<typeof parseWaitSpec>;
  try {
    spec = parseWaitSpec(input);
  } catch (e) {
    return text((e as Error).message, { error: (e as Error).message }, true);
  }
  const note = (input as { note?: unknown }).note;

  let resolved: ResolvedSpec;
  if (spec.event === "process.exit") {
    let pid = spec.pid;
    if (pid === undefined) {
      const found = pickByMatch(await env.findTagged().catch(() => []), spec.match ?? "");
      if (!found.ok) return text(found.error, { error: found.error }, true);
      pid = found.process.pid;
    }
    resolved = { event: "process.exit", label: spec.label, pid };
  } else {
    resolved = spec;
  }

  const wait = env.active.start(waitLabel(resolved, env.conditions.now()), signal);
  env.onChange();
  try {
    const outcome = await waitUntil(
      makeCheck(resolved, env.conditions),
      env.until,
      wait.controller.signal,
    );
    const details = { id: wait.id, outcome: outcome.kind };
    switch (outcome.kind) {
      case "done":
        return text(
          `${outcome.message}${typeof note === "string" && note ? ` Note: ${note}` : ""} The wait is over: go on with your instructions.`,
          details,
        );
      case "cancelled":
        return text(
          `Wait ${wait.id} was cancelled. Do not start it again unless the user asks.`,
          details,
        );
      case "error":
        return text(outcome.message, { ...details, error: outcome.message }, true);
    }
  } finally {
    env.active.finish(wait.id);
    env.onChange();
  }
}

export async function listWaits(env: WaitEnv): Promise<ToolText> {
  const procs = await env.findTagged().catch(() => []);
  const lines = [
    ...env.active.list().map((w) => `${w.id}: ${w.label}`),
    ...procs.map((pr) => `pid ${pr.pid} (${Math.round(pr.ageSeconds / 60)} min): ${pr.command}`),
  ];
  return text(lines.length ? lines.join("\n") : "No waits and no leftover processes.");
}

export function cancelWait(id: string, env: WaitEnv): ToolText {
  return text(env.active.cancel(id) ? `Cancelled ${id}.` : `No wait ${id}.`);
}
