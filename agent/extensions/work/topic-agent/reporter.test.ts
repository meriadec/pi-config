import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TopicAgentReporter, readTopicAgentEnvironment } from "./reporter.ts";

class FakeClient {
  calls: string[] = [];
  closed = false;

  async registerMainAgent() {
    this.calls.push("idle");
  }

  async heartbeatMainAgent() {
    this.calls.push("heartbeat");
  }

  async reportMainAgent(state: "thinking" | "waiting" | "stopped") {
    this.calls.push(state);
  }

  close(): void {
    this.closed = true;
  }
}

function context(
  sessionId = "session-id",
  sessionFile: string | undefined = "/tmp/session.jsonl",
  ephemeral = false,
) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => (ephemeral ? undefined : sessionFile),
    },
  } as unknown as Pick<ExtensionContext, "sessionManager">;
}

describe("Topic Agent telemetry", () => {
  test("does nothing in an ordinary Pi session", async () => {
    let connects = 0;
    const reporter = new TopicAgentReporter({
      environment: {},
      connect: async () => {
        connects += 1;
        return new FakeClient();
      },
    });
    expect(reporter.enabled).toBe(false);
    await reporter.sessionStart(context());
    await reporter.thinking();
    await reporter.waiting();
    await reporter.shutdown();
    expect(connects).toBe(0);
  });

  test("requires the complete explicit Topic environment", () => {
    expect(readTopicAgentEnvironment({ PI_WORK_TOPIC_ID: "topic" })).toBeUndefined();
    expect(
      readTopicAgentEnvironment({
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "session-id",
      }),
    ).toEqual({
      topicId: "topic",
      socketPath: "/tmp/socket",
      registrationToken: "token",
      sessionId: "session-id",
    });
  });

  test("reports lifecycle, sends heartbeat, and cleans up all session resources", async () => {
    const client = new FakeClient();
    let heartbeat = (): void => undefined;
    let timerClears = 0;
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "session-id",
      },
      connect: async () => client,
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return 1;
      }) as typeof setInterval,
      clearInterval: (() => {
        timerClears += 1;
      }) as typeof clearInterval,
    });
    await reporter.sessionStart(context());
    await reporter.thinking();
    await reporter.waiting();
    heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reporter.shutdown();
    expect(client.calls).toEqual(["idle", "thinking", "waiting", "heartbeat", "stopped"]);
    expect(timerClears).toBe(1);
    expect(client.closed).toBe(true);
  });

  test("does not register a mismatched or ephemeral Pi session", async () => {
    let connects = 0;
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "expected",
      },
      connect: async () => {
        connects += 1;
        return new FakeClient();
      },
    });
    await reporter.sessionStart(context("different"));
    await reporter.sessionStart(context("expected", "/tmp/session.jsonl", true));
    expect(connects).toBe(0);
  });
});
