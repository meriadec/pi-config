import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TopicAgentReporter, readTopicAgentEnvironment } from "./reporter.ts";

class FakeClient {
  calls: string[] = [];
  closed = false;
  registrations: Array<{ sessionId: string; affiliationToken?: string }> = [];

  async registerMainAgent(input: {
    topicId: string;
    sessionId: string;
    sessionFile: string;
    token: string;
    affiliationToken?: string;
  }) {
    this.calls.push("idle");
    this.registrations.push({
      sessionId: input.sessionId,
      ...(input.affiliationToken === undefined ? {} : { affiliationToken: input.affiliationToken }),
    });
  }

  async heartbeatMainAgent() {
    this.calls.push("heartbeat");
  }

  async reportMainAgent(state: "thinking" | "tracking-pr" | "waiting" | "stopped") {
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
  idle = true,
) {
  return {
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => (ephemeral ? undefined : sessionFile),
    },
    isIdle: () => idle,
  } as unknown as Pick<ExtensionContext, "sessionManager" | "isIdle">;
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

  test("rejects Topic Agent identity in a Delegation Job", () => {
    expect(
      readTopicAgentEnvironment({
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "main-session",
        PI_WORK_AFFILIATION: "window-affiliation",
        PI_SUB_JOB_ID: "job-123",
        PI_SUB_JOB_DIR: "/tmp/sub/job-123",
      }),
    ).toBeUndefined();
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

  test("keeps Tracking PR visible when an agent turn settles", async () => {
    const client = new FakeClient();
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "session-id",
      },
      connect: async () => client,
      setInterval: ((_callback: () => void) => 1) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    });
    await reporter.sessionStart(context());
    await reporter.trackingPr(true);
    await reporter.thinking();
    await reporter.waiting();
    await reporter.trackingPr(false);
    await reporter.shutdown();
    expect(client.calls).toEqual([
      "idle",
      "tracking-pr",
      "thinking",
      "tracking-pr",
      "waiting",
      "stopped",
    ]);
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

  test("adopts an in-window new session with the affiliation credential", async () => {
    const clients: FakeClient[] = [];
    let timerClears = 0;
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "launched-session",
        PI_WORK_AFFILIATION: "window-affiliation",
      },
      connect: async () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
      setInterval: ((_callback: () => void) => 1) as typeof setInterval,
      clearInterval: (() => {
        timerClears += 1;
      }) as typeof clearInterval,
    });
    // Originally launched session registers by exact match.
    await reporter.sessionStart(context("launched-session"));
    // The user runs /new; Pi starts a fresh session id in the same window.
    await reporter.sessionStart(context("adopted-session", "/tmp/adopted.jsonl"));
    await reporter.shutdown();
    expect(clients).toHaveLength(2);
    expect(clients[0]!.registrations).toEqual([
      { sessionId: "launched-session", affiliationToken: "window-affiliation" },
    ]);
    // The previous session's connection is closed before adopting the new one.
    expect(clients[0]!.closed).toBe(true);
    expect(timerClears).toBeGreaterThanOrEqual(1);
    expect(clients[1]!.registrations).toEqual([
      { sessionId: "adopted-session", affiliationToken: "window-affiliation" },
    ]);
  });

  test("restores the Work footer label for an adopted new session", async () => {
    const names: string[] = [];
    let currentName: string | undefined;
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "launched-session",
        PI_WORK_AFFILIATION: "window-affiliation",
        PI_WORK_TOPIC_NAME: "VG-123",
      },
      connect: async () => new FakeClient(),
      setInterval: ((_callback: () => void) => 1) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      setSessionName: (name) => {
        names.push(name);
        currentName = name;
      },
    });
    const ctx = (sessionId: string) =>
      ({
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => "/tmp/session.jsonl",
          getSessionName: () => currentName,
        },
        isIdle: () => true,
      }) as unknown as Pick<ExtensionContext, "sessionManager" | "isIdle">;
    // The launched session already carries the --name label, so no reset.
    currentName = "Work: VG-123";
    await reporter.sessionStart(ctx("launched-session"));
    // The user runs /new; the fresh session starts nameless and gets restored.
    currentName = undefined;
    await reporter.sessionStart(ctx("adopted-session"));
    await reporter.shutdown();
    expect(names).toEqual(["Work: VG-123"]);
  });

  test("does not adopt a new session without an affiliation credential", async () => {
    let connects = 0;
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "launched-session",
      },
      connect: async () => {
        connects += 1;
        return new FakeClient();
      },
    });
    await reporter.sessionStart(context("adopted-session", "/tmp/adopted.jsonl"));
    expect(connects).toBe(0);
  });

  test("reconciles a forked session that is already thinking to thinking, not idle", async () => {
    const client = new FakeClient();
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "launched-session",
        PI_WORK_AFFILIATION: "window-affiliation",
      },
      connect: async () => client,
      setInterval: ((_callback: () => void) => 1) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    });
    // The /fork pre-fills the editor and the human submits before this async
    // registration finishes, so the racing agent_start thinking() is dropped.
    // The adopted session is no longer idle when registration completes.
    await reporter.sessionStart(context("forked-session", "/tmp/forked.jsonl", false, false));
    await reporter.shutdown();
    expect(client.calls).toEqual(["idle", "thinking", "stopped"]);
  });

  test("re-asserts thinking after a reconnect so a long turn is not stranded idle", async () => {
    const clients: FakeClient[] = [];
    let failNextHeartbeat = false;
    let heartbeat = (): void => undefined;
    class ReconnectingClient extends FakeClient {
      override async heartbeatMainAgent() {
        if (failNextHeartbeat) {
          failNextHeartbeat = false;
          throw new Error("connection reset");
        }
        return super.heartbeatMainAgent();
      }
    }
    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: "topic",
        PI_WORK_SOCKET: "/tmp/socket",
        PI_WORK_REGISTRATION_TOKEN: "token",
        PI_WORK_SESSION_ID: "session-id",
      },
      connect: async () => {
        const client = new ReconnectingClient();
        clients.push(client);
        return client;
      },
      setInterval: ((callback: () => void) => {
        heartbeat = callback;
        return 1;
      }) as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    });
    await reporter.sessionStart(context());
    // The agent starts a long thinking turn (for example a Ralph Loop issue).
    await reporter.thinking();
    // The heartbeat connection drops mid-turn and the reporter reconnects.
    failNextHeartbeat = true;
    heartbeat();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await reporter.shutdown();
    // The reconnected client re-registers (idle) then re-asserts the in-flight
    // thinking, instead of stranding the lease at idle until the next turn.
    expect(clients[0]!.calls).toEqual(["idle", "thinking"]);
    expect(clients[1]!.calls).toEqual(["idle", "thinking", "stopped"]);
  });
});
