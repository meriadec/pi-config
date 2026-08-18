import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorkClient } from "../client/client.ts";
import { createAffiliationStore, createTopicStore, createWorkPaths } from "../shared/index.ts";
import type { AffiliationStore, TopicManifest, TopicStore } from "../shared/index.ts";
import type { DesktopController, MainAgentLaunch } from "./desktop.ts";
import { MainAgentManager } from "./main-agent.ts";
import { WorkDaemon } from "./server.ts";

const roots: string[] = [];

class FakeDesktop implements DesktopController {
  launches: MainAgentLaunch[] = [];
  closed: string[] = [];
  result: "launched" | "focused" = "launched";

  async accessWorkspace() {
    return { kind: "focused" as const, workspace: 1, message: "Focused." };
  }

  async openTerminal() {
    return { kind: "launched" as const, workspace: 1, message: "Opened." };
  }

  async openMainAgent(launch: MainAgentLaunch) {
    this.launches.push(launch);
    return { kind: this.result, workspace: 1, message: "Agent opened." };
  }

  async closeMainAgent(topicId: string) {
    this.closed.push(topicId);
    return { kind: "closed" as const, message: "Agent closed." };
  }
}

interface World {
  manager: MainAgentManager;
  topics: TopicStore;
  topic: TopicManifest;
  desktop: FakeDesktop;
  affiliations: AffiliationStore;
  restart(): Promise<MainAgentManager>;
  setNow(value: number): void;
  sweep(): void;
  stoppedTimers(): number;
  socketPath: string;
}

async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), "work-main-agent-"));
  roots.push(root);
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  const paths = createWorkPaths({ home: join(root, "home"), runtime });
  const topics = createTopicStore(paths);
  const affiliations = createAffiliationStore(paths);
  let topic = await topics.create({
    name: "VG-123",
    branch: "feat-vg-123",
    repository: "owner/repo",
  });
  const worktree = join(root, "worktree");
  topic = await topics.update(topic.id, (current) => ({
    ...current,
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    worktreePath: worktree,
  }));
  const desktop = new FakeDesktop();
  let now = 0;
  let callback = (): void => undefined;
  let stopped = 0;
  const socketPath = join(runtime, "pi-workd.sock");
  const build = (): MainAgentManager =>
    new MainAgentManager({
      topics,
      desktop,
      socketPath,
      affiliations,
      now: () => now,
      generateToken: () => "registration-token",
      generateAffiliation: () => "window-affiliation",
      generateSessionId: () => "123e4567-e89b-42d3-a456-426614174099",
      registrationTtlMs: 100,
      heartbeatTimeoutMs: 20,
      setInterval: ((handler: () => void) => {
        callback = handler;
        return 1;
      }) as typeof setInterval,
      clearInterval: (() => {
        stopped += 1;
      }) as typeof clearInterval,
    });
  const manager = build();
  await manager.start();
  return {
    manager,
    topics,
    topic,
    desktop,
    affiliations,
    async restart() {
      const next = build();
      await next.start();
      return next;
    },
    setNow(value) {
      now = value;
    },
    sweep() {
      callback();
    },
    stoppedTimers() {
      return stopped;
    },
    socketPath,
  };
}

async function register(item: World, connectionId = "connection-1") {
  return item.manager.register({
    connectionId,
    topicId: item.topic.id,
    sessionId: item.topic.mainAgent.sessionId,
    sessionFile: join(dirnameOfWorktree(item.topic), "session.jsonl"),
    token: "registration-token",
  });
}

function dirnameOfWorktree(topic: TopicManifest): string {
  return topic.worktreePath ?? "/tmp";
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Main Agent lease", () => {
  test("starts one deterministic launch and persists only its reported session file", async () => {
    const item = await world();
    expect(await item.manager.open(item.topic)).toMatchObject({ kind: "launched" });
    expect(item.desktop.launches[0]).toMatchObject({
      topicId: item.topic.id,
      sessionId: item.topic.id,
      registrationToken: "registration-token",
    });
    expect(item.manager.snapshot()[0]?.state).toBe("starting");

    expect(await register(item)).toMatchObject({ state: "idle", connected: true });
    expect((await item.topics.load(item.topic.id)).mainAgent.sessionFile).toBe(
      join(dirnameOfWorktree(item.topic), "session.jsonl"),
    );
  });

  test("starts a new empty session and keeps the previous session file", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    const previous = await item.topics.load(item.topic.id);
    await mkdir(dirname(previous.mainAgent.sessionFile!), { recursive: true });
    await writeFile(previous.mainAgent.sessionFile!, "previous session");

    expect(await item.manager.reset(previous)).toMatchObject({ kind: "launched" });

    expect(item.desktop.closed).toEqual([item.topic.id]);
    expect(item.desktop.launches.at(-1)?.sessionId).toBe("123e4567-e89b-42d3-a456-426614174099");
    expect((await item.topics.load(item.topic.id)).mainAgent).toEqual({
      sessionId: "123e4567-e89b-42d3-a456-426614174099",
      sessionFile: null,
    });
    expect(await Bun.file(previous.mainAgent.sessionFile!).exists()).toBeTrue();
  });

  test("validates registration tokens through the private socket protocol", async () => {
    const item = await world();
    const daemon = new WorkDaemon({
      socketPath: item.socketPath,
      runtimeDirectory: dirname(item.socketPath),
      mainAgent: item.manager,
    });
    await daemon.start();
    const client = await WorkClient.connect(item.socketPath);
    try {
      await item.manager.open(item.topic);
      await expect(
        client.registerMainAgent({
          topicId: item.topic.id,
          sessionId: item.topic.id,
          sessionFile: "/tmp/session.jsonl",
          token: "wrong",
        }),
      ).rejects.toMatchObject({ code: "invalid-registration" });
      expect(
        await client.registerMainAgent({
          topicId: item.topic.id,
          sessionId: item.topic.id,
          sessionFile: "/tmp/session.jsonl",
          token: "registration-token",
        }),
      ).toMatchObject({ state: "idle", connected: true });
      expect(await client.reportMainAgent("tracking-pr")).toMatchObject({
        state: "tracking-pr",
        connected: true,
      });
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  test("adopts a new session over the private socket protocol", async () => {
    const item = await world();
    const daemon = new WorkDaemon({
      socketPath: item.socketPath,
      runtimeDirectory: dirname(item.socketPath),
      mainAgent: item.manager,
    });
    await daemon.start();
    const client = await WorkClient.connect(item.socketPath);
    try {
      await item.manager.open(item.topic);
      const adoptedSession = "123e4567-e89b-42d3-a456-426614174100";
      expect(
        await client.registerMainAgent({
          topicId: item.topic.id,
          sessionId: adoptedSession,
          sessionFile: "/tmp/adopted.jsonl",
          token: "registration-token",
          affiliationToken: "window-affiliation",
        }),
      ).toMatchObject({ state: "idle", connected: true, sessionId: adoptedSession });
      expect((await item.topics.load(item.topic.id)).mainAgent.sessionId).toBe(adoptedSession);
    } finally {
      client.close();
      await daemon.stop();
    }
  });

  test("rejects invalid tokens and transitions through thinking, Tracking PR, waiting, and stopped", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await expect(
      item.manager.register({
        connectionId: "bad",
        topicId: item.topic.id,
        sessionId: item.topic.id,
        sessionFile: "/tmp/session.jsonl",
        token: "wrong",
      }),
    ).rejects.toMatchObject({ code: "invalid-registration" });
    await register(item);
    expect(item.manager.transition("connection-1", "thinking").state).toBe("thinking");
    expect(item.manager.transition("connection-1", "tracking-pr").state).toBe("tracking-pr");
    expect(item.manager.transition("connection-1", "waiting-for-human").state).toBe(
      "waiting-for-human",
    );
    expect(item.manager.transition("connection-1", "stopped")).toMatchObject({
      state: "stopped",
      connected: false,
    });
  });

  test("expires a lost heartbeat and permits same-session reconnect", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    item.manager.disconnected("connection-1");
    item.setNow(10);
    expect(await register(item, "connection-2")).toMatchObject({ state: "idle", connected: true });
    item.manager.heartbeat("connection-2");
    item.setNow(31);
    item.sweep();
    expect(item.manager.snapshot()[0]).toMatchObject({
      state: "failed",
      connected: false,
      reason: "Main Agent heartbeat expired.",
    });
  });

  test("adopts an in-window new session and repoints durable identity", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    const adoptedSession = "123e4567-e89b-42d3-a456-426614174100";
    const adoptedFile = join(dirnameOfWorktree(item.topic), "adopted.jsonl");
    // The originally launched socket closed when the window ran /new.
    item.manager.disconnected("connection-1");
    const lease = await item.manager.register({
      connectionId: "connection-2",
      topicId: item.topic.id,
      sessionId: adoptedSession,
      sessionFile: adoptedFile,
      token: "registration-token",
      affiliationToken: "window-affiliation",
    });
    expect(lease).toMatchObject({ state: "idle", connected: true, sessionId: adoptedSession });
    const stored = await item.topics.load(item.topic.id);
    expect(stored.mainAgent).toEqual({ sessionId: adoptedSession, sessionFile: adoptedFile });
    // At most one live lease remains for the Topic after adoption.
    expect(item.manager.snapshot()).toHaveLength(1);
  });

  test("still registers the originally launched session by exact match", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    expect(await register(item)).toMatchObject({
      state: "idle",
      connected: true,
      sessionId: item.topic.mainAgent.sessionId,
    });
    expect((await item.topics.load(item.topic.id)).mainAgent.sessionId).toBe(
      item.topic.mainAgent.sessionId,
    );
  });

  test("rejects a foreign session without a valid affiliation", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    // A different live session id with no affiliation credential is rejected,
    // whether or not it replays the launch token.
    await expect(
      item.manager.register({
        connectionId: "foreign",
        topicId: item.topic.id,
        sessionId: "123e4567-e89b-42d3-a456-426614174200",
        sessionFile: join(dirnameOfWorktree(item.topic), "foreign.jsonl"),
        token: "registration-token",
      }),
    ).rejects.toMatchObject({ code: "invalid-registration" });
    await expect(
      item.manager.register({
        connectionId: "foreign",
        topicId: item.topic.id,
        sessionId: "123e4567-e89b-42d3-a456-426614174200",
        sessionFile: join(dirnameOfWorktree(item.topic), "foreign.jsonl"),
        token: "wrong",
        affiliationToken: "not-a-window",
      }),
    ).rejects.toMatchObject({ code: "invalid-registration" });
    // Durable identity is unchanged by the rejected attempts.
    expect((await item.topics.load(item.topic.id)).mainAgent.sessionId).toBe(
      item.topic.mainAgent.sessionId,
    );
  });

  test("rejects a cross-Topic affiliation adoption attempt", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    // A second, never-launched Topic. This window is affiliated only with the
    // first Topic and cannot claim the second Topic's Main Agent identity.
    const other = await item.topics.create({
      name: "VG-999",
      branch: "feat-vg-999",
      repository: "owner/repo",
    });
    await expect(
      item.manager.register({
        connectionId: "cross",
        topicId: other.id,
        sessionId: "123e4567-e89b-42d3-a456-426614174300",
        sessionFile: join(dirnameOfWorktree(item.topic), "cross.jsonl"),
        token: "registration-token",
        affiliationToken: "window-affiliation",
      }),
    ).rejects.toMatchObject({ code: "invalid-registration" });
    expect((await item.topics.load(other.id)).mainAgent.sessionId).toBe(other.mainAgent.sessionId);
  });

  test("re-attaches a live window through a durable affiliation after a restart", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    // The daemon restarts: the in-memory registration and lease are gone, but
    // the window still holds its durable affiliation credential.
    item.manager.stop();
    const restarted = await item.restart();
    expect(restarted.snapshot()[0]).toMatchObject({ state: "stopped", connected: false });
    // The still-live window reconnects and re-registers its current session.
    // The launch token is no longer valid, so it re-attaches through adoption.
    const adoptedFile = join(dirnameOfWorktree(item.topic), "session.jsonl");
    const lease = await restarted.register({
      connectionId: "reconnect-1",
      topicId: item.topic.id,
      sessionId: item.topic.mainAgent.sessionId,
      sessionFile: adoptedFile,
      token: "registration-token",
      affiliationToken: "window-affiliation",
    });
    expect(lease).toMatchObject({ state: "idle", connected: true });
    restarted.stop();
  });

  test("drops persisted affiliations for topics that no longer exist on restart", async () => {
    const item = await world();
    await item.manager.open(item.topic);
    await register(item);
    item.manager.stop();
    // The Topic is deleted while the daemon is down.
    await item.topics.delete(item.topic.id);
    const restarted = await item.restart();
    restarted.stop();
    // Restart pruned the stale credential, so it is no longer persisted.
    expect(await item.affiliations.load()).toEqual(new Map());
  });

  test("cleans up its daemon timer", async () => {
    const item = await world();
    item.manager.stop();
    expect(item.stoppedTimers()).toBe(1);
    expect(item.manager.snapshot()).toEqual([]);
  });
});
