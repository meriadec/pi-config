import { describe, expect, test } from "bun:test";
import type { MainAgentCallRequest } from "../infrastructure/rpc/client.ts";
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

function context(
  options: {
    readonly sessionId?: string;
    readonly sessionFile?: string | undefined;
    readonly sessionName?: string | undefined;
    readonly idle?: boolean;
  } = {},
) {
  return {
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "session-1",
      getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/tmp/session.jsonl"),
      getSessionName: () => ("sessionName" in options ? options.sessionName : "Work: Adapter"),
    },
  } as never;
}

function makeRuntime(
  onCall: (request: MainAgentCallRequest) => void | Promise<void> = () => undefined,
) {
  const calls: string[] = [];
  let scheduled: (() => void) | undefined;
  const runtime = {
    clientId: ClientId.make("20000000-0000-4000-8000-000000000001"),
    repeat: (_interval: number, task: () => void) => {
      scheduled = task;
      return () => calls.push("schedule-stopped");
    },
    mainAgentCall: async (request: MainAgentCallRequest) => {
      calls.push(request.action === "report" ? `report:${request.activity}` : request.action);
      await onCall(request);
    },
    dispose: async () => calls.push("disposed"),
  } as unknown as WorkClientRuntime;
  return {
    calls,
    runtime,
    cycle: async () => {
      scheduled?.();
      await tick();
    },
  };
}

describe("Effect Topic Agent reporter", () => {
  test("is lazy in ordinary sessions and disables Topic identity in Delegation Jobs", async () => {
    let made = 0;
    const makeRuntime = () => {
      made += 1;
      return makeRuntimeStub();
    };
    const ordinary = new EffectTopicAgentReporter({ environment: {}, makeRuntime });
    const delegation = new EffectTopicAgentReporter({
      environment: { ...environment, PI_SUB_JOB_ID: "job", PI_SUB_JOB_DIR: "/tmp/job" },
      makeRuntime,
    });

    expect(ordinary.enabled).toBeFalse();
    expect(delegation.enabled).toBeFalse();
    await ordinary.sessionStart(context());
    await delegation.sessionStart(context());
    expect(made).toBe(0);
  });

  test("keeps a newly registered idle session idle until an agent turn settles", async () => {
    const fake = makeRuntime();
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => fake.runtime,
    });

    await reporter.sessionStart(context({ idle: true }));

    expect(fake.calls).toEqual(["register"]);
    await reporter.thinking();
    await reporter.waiting();
    expect(fake.calls).toEqual(["register", "report:thinking", "report:waiting-for-human"]);
    await reporter.shutdown();
  });

  test("registers the launched session and adopts an affiliated in-window session", async () => {
    const first = makeRuntime();
    const second = makeRuntime();
    const runtimes = [first.runtime, second.runtime];
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => runtimes.shift()!,
    });

    await reporter.sessionStart(context());
    await reporter.sessionStart(
      context({ sessionId: "session-2", sessionFile: "/tmp/session-2.jsonl" }),
    );
    await reporter.shutdown();

    expect(first.calls).toContain("register");
    expect(first.calls).not.toContain("adopt");
    expect(first.calls).toContain("schedule-stopped");
    expect(first.calls).toContain("disposed");
    expect(second.calls).toContain("adopt");
    expect(second.calls).not.toContain("register");
  });

  test("refuses affiliation and ephemeral session adoption before making a runtime", async () => {
    let made = 0;
    const reporter = new EffectTopicAgentReporter({
      environment: { ...environment, PI_WORK_AFFILIATION: undefined },
      makeRuntime: () => {
        made += 1;
        return makeRuntimeStub();
      },
    });

    await reporter.sessionStart(context({ sessionId: "other" }));
    await reporter.sessionStart(context({ sessionFile: undefined }));
    expect(made).toBe(0);
  });

  test("restores the Topic session name only when it is absent", async () => {
    const names: string[] = [];
    const first = makeRuntime();
    const second = makeRuntime();
    const runtimes = [first.runtime, second.runtime];
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => runtimes.shift()!,
      setSessionName: (name) => names.push(name),
    });

    await reporter.sessionStart(context());
    await reporter.sessionStart(context({ sessionId: "session-2", sessionName: undefined }));
    await reporter.shutdown();

    expect(names).toEqual(["Work: Adapter"]);
  });

  test("registers or adopts immediately after a missing heartbeat without a false log", async () => {
    let registrations = 0;
    const logs: string[] = [];
    const fake = makeRuntime((request) => {
      if (request.action === "heartbeat") throw new Error("missing connection");
      if (request.action === "register" && registrations++ > 0) {
        throw new Error("registration was consumed");
      }
    });
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => fake.runtime,
      log: (message) => logs.push(message),
    });

    await reporter.sessionStart(context());
    await reporter.thinking();
    const beforeRecovery = fake.calls.length;
    await fake.cycle();

    expect(fake.calls.slice(beforeRecovery)).toEqual([
      "heartbeat",
      "register",
      "adopt",
      "report:thinking",
    ]);
    expect(logs).toEqual([]);
    await reporter.shutdown();
  });

  test("logs re-attach failure only when register and adopt both fail", async () => {
    let registrations = 0;
    const logs: string[] = [];
    const fake = makeRuntime((request) => {
      if (request.action === "heartbeat") throw new Error("missing connection");
      if (request.action === "register" && registrations++ > 0) {
        throw new Error("registration was consumed");
      }
      if (request.action === "adopt") throw new Error("affiliation refused");
    });
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => fake.runtime,
      log: (message) => logs.push(message),
    });

    await reporter.sessionStart(context());
    await fake.cycle();

    expect(logs).toEqual(["re-attach failed: affiliation refused"]);
    await reporter.shutdown();
  });

  test("preserves activity precedence and reasserts each effective state after recovery", async () => {
    let registrations = 0;
    const fake = makeRuntime((request) => {
      if (request.action === "heartbeat") throw new Error("missing connection");
      if (request.action === "register" && registrations++ > 0) {
        throw new Error("registration was consumed");
      }
    });
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => fake.runtime,
      log: () => undefined,
    });

    await reporter.sessionStart(context());
    await fake.cycle();
    await reporter.trackingPr(true);
    await fake.cycle();
    await reporter.delegationActivity(true);
    await fake.cycle();
    await reporter.thinking();
    await reporter.trackingPr(false);
    await reporter.delegationActivity(false);
    await fake.cycle();
    await reporter.waiting();
    await reporter.delegationActivity(true);
    await reporter.trackingPr(true);
    await fake.cycle();
    await reporter.delegationActivity(false);
    await reporter.trackingPr(false);
    await reporter.shutdown();

    expect(fake.calls.filter((call) => call.startsWith("report:"))).toEqual([
      "report:waiting-for-human",
      "report:tracking-pr",
      "report:tracking-pr",
      "report:thinking-sub",
      "report:thinking-sub",
      "report:thinking",
      "report:thinking",
      "report:waiting-for-human",
      "report:thinking-sub",
      "report:thinking-sub",
      "report:tracking-pr",
      "report:waiting-for-human",
      "report:stopped",
    ]);
    expect(fake.calls.slice(-3)).toEqual(["schedule-stopped", "report:stopped", "disposed"]);
  });

  test("reconciles a session that is already thinking during registration", async () => {
    const fake = makeRuntime();
    const reporter = new EffectTopicAgentReporter({
      environment,
      makeRuntime: () => fake.runtime,
    });

    await reporter.sessionStart(context({ idle: false }));
    await reporter.shutdown();

    expect(fake.calls.filter((call) => call.startsWith("report:"))).toEqual([
      "report:thinking",
      "report:stopped",
    ]);
  });
});

function makeRuntimeStub(): WorkClientRuntime {
  return makeRuntime().runtime;
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
