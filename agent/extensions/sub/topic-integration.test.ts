import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_PROTOCOL_VERSION, type DaemonSnapshot } from "../work/daemon/protocol.ts";
import type { DesktopController, MainAgentLaunch } from "../work/daemon/desktop.ts";
import { MainAgentManager } from "../work/daemon/main-agent.ts";
import { readTopicAgentEnvironment, TopicAgentReporter } from "../work/topic-agent/reporter.ts";
import { createTopicStore, createWorkPaths } from "../work/shared/index.ts";
import type { TopicManifest } from "../work/shared/index.ts";
import {
  hydrateDashboard,
  initialDashboardState,
  renderDashboard,
} from "../work/client/dashboard.ts";
import { buildChildEnvironment } from "./launcher.ts";
import {
  SUB_CUSTOM_JOB,
  completeDelegationJob,
  readJobStatus,
  resultPath,
  transitionJobStatus,
  writeJobStatus,
  type DelegationJobRecord,
  type DelegationResultRecord,
} from "./mailbox.ts";
import { ParentMailboxCoordinator, type ParentMailboxDependencies } from "./parent-mailbox.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakeDesktop implements DesktopController {
  launch: MainAgentLaunch | undefined;

  async accessWorkspace() {
    return { kind: "focused" as const, workspace: 1, message: "Focused." };
  }

  async openTerminal() {
    return { kind: "launched" as const, workspace: 1, message: "Opened." };
  }

  async openMainAgent(launch: MainAgentLaunch) {
    this.launch = launch;
    return { kind: "launched" as const, workspace: 1, message: "Main Agent opened." };
  }

  async closeMainAgent() {
    return { kind: "closed" as const, message: "Main Agent closed." };
  }
}

class FakeEventBus {
  private listener: ((active: boolean) => void | Promise<void>) | undefined;
  private pending: Promise<void>[] = [];

  on(listener: (active: boolean) => void | Promise<void>): void {
    this.listener = listener;
  }

  emit(active: boolean): void {
    this.pending.push(Promise.resolve(this.listener?.(active)));
  }

  async flush(): Promise<void> {
    await Promise.all(this.pending.splice(0));
  }
}

class FakeKittyProcess {
  environment: NodeJS.ProcessEnv | undefined;

  async launch(
    parentEnvironment: NodeJS.ProcessEnv,
    job: DelegationJobRecord,
  ): Promise<NodeJS.ProcessEnv> {
    const environment = buildChildEnvironment(
      { cwd: job.cwd, jobId: job.jobId, jobDir: job.jobDir },
      parentEnvironment,
    );
    this.environment = environment;
    await transitionJobStatus(job.jobDir, "launched");
    return environment;
  }
}

function stripSgr(text: string): string {
  let visible = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\x1b" && text[index + 1] === "[") {
      while (index < text.length && text[index] !== "m") index += 1;
    } else {
      visible += text[index];
    }
  }
  return visible;
}

function snapshot(topic: TopicManifest, manager: MainAgentManager): DaemonSnapshot {
  return {
    revision: 1,
    topics: [topic],
    diagnostics: [],
    operations: [],
    knownRepositories: [topic.repository],
    mainAgents: manager.snapshot(),
    baseCheckouts: { [topic.id]: "/base/repo" },
    daemon: {
      protocolVersion: WORK_PROTOCOL_VERSION,
      pid: 1,
      startedAt: "2026-07-03T10:00:00.000Z",
    },
  };
}

function dashboardText(topic: TopicManifest, manager: MainAgentManager): string {
  const state = hydrateDashboard(initialDashboardState(), snapshot(topic, manager));
  return stripSgr(renderDashboard(state, 120, 24).join("\n"));
}

function jobEntry(job: DelegationJobRecord): unknown {
  return { type: "custom", customType: SUB_CUSTOM_JOB, data: job };
}

describe("Topic Delegation Job integration", () => {
  test("keeps the Main Agent identity and imports one Delegation Result into its parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sub-topic-integration-"));
    roots.push(root);
    const runtime = join(root, "runtime");
    await mkdir(runtime, { recursive: true });
    const topics = createTopicStore(createWorkPaths({ home: join(root, "home"), runtime }));
    let topic = await topics.create({
      name: "Delegation integration",
      branch: "feat-delegation-integration",
      repository: "owner/repo",
    });
    topic = await topics.update(topic.id, (current) => ({
      ...current,
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
      },
      worktreePath: join(root, "worktree"),
    }));

    const desktop = new FakeDesktop();
    const manager = new MainAgentManager({
      topics,
      desktop,
      socketPath: join(runtime, "pi-workd.sock"),
      generateToken: () => "parent-registration-token",
      generateAffiliation: () => "parent-window-affiliation",
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
    });
    await manager.start();
    await manager.open(topic);
    const launch = desktop.launch!;
    const parentSessionFile = join(root, "sessions", "parent.jsonl");

    const reporter = new TopicAgentReporter({
      environment: {
        PI_WORK_TOPIC_ID: launch.topicId,
        PI_WORK_SOCKET: launch.socketPath,
        PI_WORK_REGISTRATION_TOKEN: launch.registrationToken,
        PI_WORK_SESSION_ID: launch.sessionId,
        PI_WORK_AFFILIATION: launch.affiliationToken,
        PI_WORK_TOPIC_NAME: launch.topicName,
      },
      connect: async () => ({
        registerMainAgent: async (input) =>
          manager.register({ connectionId: "parent-connection", ...input }),
        heartbeatMainAgent: async () => manager.heartbeat("parent-connection"),
        reportMainAgent: async (state) =>
          manager.transition(
            "parent-connection",
            state === "waiting" ? "waiting-for-human" : state,
          ),
        close: () => undefined,
      }),
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: (() => undefined) as typeof clearInterval,
      setTimeout: ((handler: () => void) => {
        handler();
        return 1;
      }) as unknown as typeof setTimeout,
      clearTimeout: (() => undefined) as typeof clearTimeout,
    });
    await reporter.sessionStart({
      isIdle: () => true,
      sessionManager: {
        getSessionId: () => launch.sessionId,
        getSessionFile: () => parentSessionFile,
        getSessionName: () => `Work: ${topic.name}`,
      },
    } as never);
    const originalMainAgent = (await topics.load(topic.id)).mainAgent;

    const jobDir = join(root, "mailbox", "job-123");
    const job: DelegationJobRecord = {
      jobId: "job-123",
      jobDir,
      prompt: "Inspect the integration boundary.",
      cwd: topic.worktreePath!,
      createdAt: "2026-07-03T10:01:00.000Z",
      parentSessionId: launch.sessionId,
      parentSessionFile,
    };
    await writeJobStatus(jobDir, {
      status: "created",
      jobId: job.jobId,
      createdAt: job.createdAt,
      updatedAt: job.createdAt,
      parentSessionFile,
      handoffMode: "fresh",
    });

    const parentEnvironment: NodeJS.ProcessEnv = {
      PI_WORK_TOPIC_ID: launch.topicId,
      PI_WORK_SOCKET: launch.socketPath,
      PI_WORK_REGISTRATION_TOKEN: launch.registrationToken,
      PI_WORK_SESSION_ID: launch.sessionId,
      PI_WORK_AFFILIATION: launch.affiliationToken,
      PI_WORK_TOPIC_NAME: launch.topicName,
    };
    const childEnvironment = await new FakeKittyProcess().launch(parentEnvironment, job);
    expect(childEnvironment).toMatchObject({
      PI_SUB_JOB_ID: job.jobId,
      PI_SUB_JOB_DIR: job.jobDir,
    });
    expect(Object.keys(childEnvironment).some((key) => key.startsWith("PI_WORK_"))).toBeFalse();
    expect(readTopicAgentEnvironment(childEnvironment)).toBeUndefined();
    await transitionJobStatus(jobDir, "thinking");

    const bus = new FakeEventBus();
    bus.on((active) => reporter.delegationActivity(active));
    const imports: DelegationResultRecord[] = [];
    const deliveries: Array<{ record: DelegationResultRecord; content: string }> = [];
    const dependencies: ParentMailboxDependencies = {
      identity: { sessionId: launch.sessionId, sessionFile: parentSessionFile },
      appendImport: (record) => imports.push(record),
      deliverFollowUp: (record, content) => deliveries.push({ record, content }),
      readResult: async (record) => {
        try {
          return await readFile(resultPath(record.jobDir), "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        }
      },
      readStatus: async (record) => readJobStatus(record.jobDir),
      readLegacyParentSessionFile: async () => parentSessionFile,
      publishActivity: (active) => bus.emit(active),
      now: () => new Date("2026-07-03T10:02:00.000Z"),
      timers: { setInterval: () => 1, clearInterval: () => undefined },
      diagnostic: () => undefined,
      truncateResult: (result) => result,
    };
    const parentMailbox = new ParentMailboxCoordinator(dependencies);
    await parentMailbox.restore([jobEntry(job)]);
    await bus.flush();
    expect(manager.snapshot()[0]?.state).toBe("thinking-sub");
    expect(dashboardText(topic, manager)).toContain("thinking (sub)");

    await reporter.thinking();
    expect(manager.snapshot()[0]?.state).toBe("thinking");
    expect(dashboardText(topic, manager)).toContain("thinking");
    expect(dashboardText(topic, manager)).not.toContain("thinking (sub)");
    await reporter.waiting();
    expect(manager.snapshot()[0]?.state).toBe("thinking-sub");
    expect(dashboardText(topic, manager)).toContain("thinking (sub)");

    await completeDelegationJob(job.jobId, job.jobDir, "The integration boundary is correct.");
    await parentMailbox.pollNow();
    await parentMailbox.pollNow();
    await bus.flush();
    expect(deliveries).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(deliveries[0]?.content).toContain("The integration boundary is correct.");

    // Regression: the historical child self-import sequence cannot claim the parent's job.
    const childDeliveries: string[] = [];
    const childMailbox = new ParentMailboxCoordinator({
      ...dependencies,
      identity: { sessionId: "child-session", sessionFile: join(jobDir, "child.jsonl") },
      appendImport: () => undefined,
      deliverFollowUp: (_record, content) => childDeliveries.push(content),
      publishActivity: () => undefined,
    });
    await childMailbox.restore([jobEntry(job)]);
    await childMailbox.pollNow();
    expect(childDeliveries).toHaveLength(0);

    expect((await topics.load(topic.id)).mainAgent).toEqual(originalMainAgent);
    expect(originalMainAgent).toEqual({
      sessionId: launch.sessionId,
      sessionFile: parentSessionFile,
    });

    childMailbox.stop();
    parentMailbox.stop();
    await reporter.shutdown();
    manager.stop();
  });
});
