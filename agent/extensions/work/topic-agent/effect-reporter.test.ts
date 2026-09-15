import { describe, expect, test } from "bun:test";
import { ClientId } from "../domain/index.ts";
import type { WorkClientRuntime } from "../client/effect-runtime.ts";
import { EffectTopicAgentReporter } from "./effect-reporter.ts";

const environment = {
  PI_WORK_TOPIC_ID: "10000000-0000-4000-8000-000000000001",
  PI_WORK_SOCKET: "/run/user/1/pi-workd.sock",
  PI_WORK_REGISTRATION_TOKEN: "registration",
  PI_WORK_AFFILIATION: "affiliation",
  PI_WORK_SESSION_ID: "session-1",
  PI_WORK_TOPIC_NAME: "Adapter",
};

function context() {
  return {
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/tmp/session.jsonl",
      getSessionName: () => "Work: Adapter",
    },
  } as never;
}

describe("Effect Topic Agent reporter", () => {
  test("is lazy and disabled in a Delegation Job", () => {
    let made = 0;
    const reporter = new EffectTopicAgentReporter({
      environment: { ...environment, PI_SUB_JOB_ID: "job", PI_SUB_JOB_DIR: "/tmp/job" },
      makeRuntime: () => {
        made += 1;
        return {} as WorkClientRuntime;
      },
    });
    expect(reporter.enabled).toBeFalse();
    expect(made).toBe(0);
  });

  test("uses one retry schedule and reasserts activity after repeated outages", async () => {
    const calls: string[] = [];
    let scheduled: (() => void) | undefined;
    let heartbeatFailures = 2;
    const runtime = {
      clientId: ClientId.make("20000000-0000-4000-8000-000000000001"),
      repeat: (_interval: number, task: () => void) => {
        scheduled = task;
        return () => calls.push("schedule-stopped");
      },
      mainAgentCall: async (request: { action: string; activity?: string }) => {
        calls.push(
          request.activity === undefined ? request.action : `${request.action}:${request.activity}`,
        );
        if (request.action === "heartbeat" && heartbeatFailures-- > 0) throw new Error("offline");
      },
      dispose: async () => calls.push("disposed"),
    } as unknown as WorkClientRuntime;
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => runtime,
      log: () => undefined,
    });

    await reporter.sessionStart(context());
    await reporter.thinking();
    scheduled!();
    await tick();
    scheduled!();
    await tick();
    scheduled!();
    await tick();
    scheduled!();
    await tick();

    expect(calls.filter((call) => call === "register").length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((call) => call === "report:thinking").length).toBeGreaterThanOrEqual(2);
    await reporter.shutdown();
    expect(calls).toContain("schedule-stopped");
    expect(calls).toContain("disposed");
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
