import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { DaemonSnapshot, WorkEvent } from "../daemon/protocol.ts";
import type { TopicMutationResult, WorkActionResult } from "../daemon/topic-service.ts";
import type { MainAgentActionResult, WorkspaceActionResult } from "../daemon/desktop.ts";
import type { NewTopic, TopicManifest } from "../shared/domain.ts";
import { createConfigStore, createWorkPaths } from "../shared/index.ts";
import { WorkDashboardComponent, type DashboardClient } from "./dashboard-component.ts";
import {
  dashboardViewModel,
  handleDashboardInput,
  hydrateDashboard,
  initialDashboardState,
  reduceDashboardEvent,
  renderDashboard,
  defaultBranchForTopicName,
  isValidRepositoryInput,
} from "./dashboard.ts";
import { completeWorkBaseSetup, defaultWorkConfig, validateWorkBase } from "./setup.ts";

const roots: string[] = [];
const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-dashboard-test-"));
  roots.push(root);
  return root;
}

function topic(id: string, name: string, setup: TopicManifest["setup"]["state"] = "ready") {
  return {
    version: 1,
    id,
    name,
    branch: `feat-${name}`,
    repository: `owner/${name.toLowerCase()}`,
    setup: {
      state: setup,
      repositoryAvailable: setup === "ready",
      worktreeCreated: setup === "ready",
      setupCommandsRun: setup === "ready",
      ...(setup === "setup-failed" ? { reason: "wt failed" } : {}),
    },
    worktreePath: setup === "ready" ? `/work/${name}` : null,
    mainAgent: { sessionId: id, sessionFile: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies TopicManifest;
}

function snapshot(topics: readonly TopicManifest[] = []): DaemonSnapshot {
  return {
    revision: 0,
    topics,
    diagnostics: [],
    operations: [],
    mainAgents: topics.map((item) => ({
      topicId: item.id,
      sessionId: item.id,
      state: "stopped",
      connected: false,
    })),
    baseCheckouts: Object.fromEntries(
      topics.map((item) => [item.id, `/base/${item.repository.split("/")[1]}`]),
    ),
    daemon: { protocolVersion: 7, pid: 10, startedAt: "2026-01-01T00:00:00.000Z" },
  };
}

describe("WORK_BASE setup", () => {
  test("expands, validates, and saves a writable absolute directory", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const workBase = join(home, "ledger");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workBase, { recursive: true }), mkdir(runtime, { recursive: true })]);
    const paths = createWorkPaths({ home, runtime });
    const store = createConfigStore(paths);
    const answers = ["relative", "~/ledger"];
    const errors: string[] = [];

    const configured = await completeWorkBaseSetup(
      store,
      {
        input: async () => answers.shift(),
        notify: (message) => errors.push(message),
      },
      { home },
    );

    expect(errors).toEqual(["WORK_BASE must be an absolute directory path."]);
    expect(configured?.workBase).toBe(workBase);
    expect((await store.load())?.workBase).toBe(workBase);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({ workBase });
  });

  test("rejects missing, non-directory, and non-writable paths", async () => {
    expect(
      await validateWorkBase("/missing", {
        fileSystem: {
          stat: async () => {
            throw new Error("missing");
          },
          access,
        },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must exist and be writable." });
    expect(
      await validateWorkBase("/file", {
        fileSystem: { stat: async () => ({ isDirectory: () => false }), access },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must be a directory." });
    expect(
      await validateWorkBase("/locked", {
        fileSystem: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => {
            throw new Error("locked");
          },
        },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must exist and be writable." });
  });

  test("cancels without creating partial configuration", async () => {
    const root = await temporaryRoot();
    const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
    const result = await completeWorkBaseSetup(createConfigStore(paths), {
      input: async () => undefined,
      notify: () => undefined,
    });
    expect(result).toBeUndefined();
    expect(await Bun.file(paths.config).exists()).toBeFalse();
  });

  test("keeps existing policy configuration when workBase is added", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const base = join(root, "base");
    const paths = createWorkPaths({ home, runtime: join(root, "runtime") });
    await mkdir(base, { recursive: true });
    const store = createConfigStore(paths);
    const config = defaultWorkConfig(base);
    delete config.workBase;
    config.policies.defaults["terminal.open"] = "deny";
    await store.save(config);
    await completeWorkBaseSetup(store, {
      input: async () => base,
      notify: () => undefined,
    });
    expect((await store.load())?.policies.defaults["terminal.open"]).toBe("deny");
  });
});

describe("Topic creation wizard", () => {
  test("makes deterministic safe branch defaults", () => {
    expect(defaultBranchForTopicName("VG-123 Fix Login")).toBe("VG-123-fix-login");
    expect(defaultBranchForTopicName("Write a useful release note")).toBe(
      "write-a-useful-release-note",
    );
    expect(defaultBranchForTopicName("  Spaces & punctuation!!!  ")).toBe("spaces-punctuation");
    expect(defaultBranchForTopicName("Été déjà vu")).toBe("ete-deja-vu");
    expect(defaultBranchForTopicName(" : / .. ")).toBe("");
    expect(defaultBranchForTopicName("   ")).toBe("");
  });

  test("asks for the repository before the generated Branch", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "VG-123 Fix Login").state;
    state = handleDashboardInput(state, "\r").state;

    expect(state.wizard).toMatchObject({
      stage: "repository",
      branch: "VG-123-fix-login",
    });
  });

  test("accepts bracketed paste through the wizard text input", async () => {
    const component = dashboardComponent(new FakeDashboardClient());
    await Bun.sleep(0);
    component.handleInput("a");
    component.handleInput("\x1b[200~VG-31025 Tokenization\x1b[201~");
    component.handleInput("\r");

    expect(component.snapshotState().wizard).toMatchObject({
      stage: "repository",
      name: "VG-31025 Tokenization",
    });
    component.dispose();
  });

  test("supports cursor editing in wizard fields", async () => {
    const component = dashboardComponent(new FakeDashboardClient());
    await Bun.sleep(0);
    component.handleInput("a");
    component.handleInput("Cursor test");
    component.handleInput("\r");
    component.handleInput("owner/reo");
    component.handleInput("\x1b[D");
    component.handleInput("p");
    component.handleInput("\r");

    expect(component.snapshotState().wizard).toMatchObject({
      stage: "branch",
      repository: "owner/repo",
    });
    component.dispose();
  });

  test("keeps the generated branch editable and validates repository references", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "VG-123 Fix Login").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({ stage: "repository", branch: "VG-123-fix-login" });
    state = handleDashboardInput(state, "LedgerHQ/revault").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("branch");
    state = handleDashboardInput(state, "\x7f").state;
    state = handleDashboardInput(state, "-api").state;
    expect(state.wizard?.branch).toBe("VG-123-fix-logi-api");
    expect(isValidRepositoryInput("LedgerHQ/revault")).toBeTrue();
    expect(isValidRepositoryInput("https://github.com/LedgerHQ/revault")).toBeFalse();
    expect(isValidRepositoryInput("owner/")).toBeFalse();
  });

  test("does not advance with empty or unsafe fields", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({ stage: "name", error: "Topic name must not be empty." });
    state = handleDashboardInput(state, "***").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({
      stage: "name",
      error: "Topic name cannot make a safe branch.",
    });
  });

  test("cancels without submission from every wizard stage", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "Alpha").state;
    state = handleDashboardInput(state, "\r").state;
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("repository");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "owner/repo").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("branch");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("review");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
  });

  test("shows and submits the exact reviewed repository and branch", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    for (const input of ["Alpha", "\r", "owner/repo", "\r", "-edited", "\r"]) {
      state = handleDashboardInput(state, input).state;
    }
    const lines = renderDashboard(state, 80, 16).join("\n");
    expect(lines).toContain("Repository: owner/repo");
    expect(lines).toContain("Branch: alpha-edited");
    const result = handleDashboardInput(state, "\r");
    expect(result.action).toEqual({
      type: "create",
      input: { name: "Alpha", branch: "alpha-edited", repository: "owner/repo" },
    });
  });
});

describe("dashboard state and navigation", () => {
  test("builds loading, empty, connected, reconnecting, failure, and diagnostic views", () => {
    const loading = initialDashboardState();
    expect(dashboardViewModel(loading).kind).toBe("loading");
    const empty = hydrateDashboard(loading, snapshot());
    expect(dashboardViewModel(empty).kind).toBe("empty");
    const connected = hydrateDashboard(empty, {
      ...snapshot([topic(ID_A, "Alpha")]),
      diagnostics: [{ topicId: "broken", code: "invalid-data", message: "Corrupt Topic." }],
    });
    expect(dashboardViewModel(connected)).toMatchObject({
      kind: "connected",
      diagnostics: [{ message: "Corrupt Topic." }],
    });
    expect(
      dashboardViewModel(reduceDashboardEvent(connected, { type: "daemon-stopping" })).kind,
    ).toBe("reconnecting");
    expect(
      dashboardViewModel({ ...connected, phase: "failure", message: "socket failed" }),
    ).toEqual({ kind: "failure", message: "socket failed" });
  });

  test("reduces semantic events and preserves selection by Topic id across sorting", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_B, "Beta"), topic(ID_A, "Alpha")]),
    );
    state = handleDashboardInput(state, "j").state;
    expect(state.selectedTopicId).toBe(ID_B);
    state = reduceDashboardEvent(state, {
      type: "topic-changed",
      topic: topic(ID_B, "Aardvark"),
    });
    expect(state.topics[0]?.id).toBe(ID_B);
    expect(state.selectedTopicId).toBe(ID_B);
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "thinking", connected: true },
    });
    expect(state.mainAgents.find((agent) => agent.topicId === ID_B)?.state).toBe("thinking");
    state = reduceDashboardEvent(state, { type: "topic-removed", topicId: ID_B });
    expect(state.selectedTopicId).toBe(ID_A);
  });

  test("opens the action rail on its first available action and supports navigation", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]),
    );
    state = handleDashboardInput(state, "\x1b[B").state;
    expect(state.selectedTopicId).toBe(ID_B);
    state = handleDashboardInput(state, "k").state;
    expect(state.selectedTopicId).toBe(ID_A);
    state = { ...state, unavailableActions: { [ID_A]: ["workspace"] } };
    state = handleDashboardInput(state, "l").state;
    expect(state.sidebarOpen).toBeTrue();
    expect(state.focus).toBe("actions");
    expect(state.focusedAction).toBe(1);
    state = handleDashboardInput(state, "h").state;
    expect(state.focus).toBe("detail");
    state = handleDashboardInput(state, "l").state;
    expect(state.focus).toBe("actions");
    state = handleDashboardInput(state, "\r").state;
    expect(state.sidebarOpen).toBeTrue();
    const close = handleDashboardInput(state, "q");
    expect(close.exit).toBeFalse();
    expect(close.state.sidebarOpen).toBeFalse();
    const reopened = handleDashboardInput(close.state, "l").state;
    expect(reopened.sidebarOpen).toBeTrue();
    expect(handleDashboardInput(reopened, "\x1b").exit).toBeTrue();
  });

  test("jumps directly from the Topic list to the selected Topic Main Agent", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));

    const result = handleDashboardInput(state, "m");

    expect(result.action).toEqual({ type: "agent", topicId: ID_A });
    expect(result.state).toMatchObject({
      focus: "list",
      sidebarOpen: false,
      submissionInFlight: "agent",
      message: "Open Main Agent…",
    });
  });

  test("offers a new Main Agent action in the action rail", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = handleDashboardInput(state, "l").state;
    for (let index = 0; index < 3; index += 1) state = handleDashboardInput(state, "j").state;

    expect(handleDashboardInput(state, "\r").action).toEqual({
      type: "reset-agent",
      topicId: ID_A,
    });
    expect(renderDashboard(state, 100, 24).join("\n")).toContain("Start New Main Agent");
  });

  test("does not jump to an unavailable Main Agent", () => {
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([topic(ID_A, "Alpha")]),
      deniedActions: { [ID_A]: ["agent.open"] },
    });

    expect(handleDashboardInput(state, "m").action).toBeUndefined();
  });

  test("jumps directly from the Topic list to the selected Topic workspace", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));

    const result = handleDashboardInput(state, "o");

    expect(result.action).toEqual({ type: "workspace", topicId: ID_A });
    expect(result.state).toMatchObject({
      focus: "list",
      sidebarOpen: false,
      submissionInFlight: "workspace",
      message: "Access Topic Workspace…",
    });
  });

  test("does not jump to an unavailable workspace", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = { ...state, unavailableActions: { [ID_A]: ["workspace"] } };

    expect(handleDashboardInput(state, "o").action).toBeUndefined();
  });

  test("moves through actions with Vim and arrow keys and creates typed invocations", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = handleDashboardInput(state, "l").state;
    expect(state.focus).toBe("actions");
    state = handleDashboardInput(state, "j").state;
    expect(state.focusedAction).toBe(1);
    const terminal = handleDashboardInput(state, "\r");
    expect(terminal.action).toEqual({ type: "terminal", topicId: ID_A });

    const { submissionInFlight: _submission, ...readyState } = terminal.state;
    state = handleDashboardInput(readyState, "\x1b[A").state;
    expect(state.focusedAction).toBe(0);
    expect(handleDashboardInput(state, "\r").action).toEqual({
      type: "workspace",
      topicId: ID_A,
    });
  });

  test("makes daemon-denied actions unavailable without invocation", () => {
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([topic(ID_A, "Alpha")]),
      deniedActions: { [ID_A]: ["terminal.open", "agent.open", "topic.delete"] },
    });
    state = handleDashboardInput(state, "l").state;
    state = handleDashboardInput(state, "l").state;
    state = handleDashboardInput(state, "j").state;
    expect(handleDashboardInput(state, "\r").action).toBeUndefined();
    const rendered = renderDashboard(state, 100, 24).join("\n");
    expect(rendered).toContain("Open Terminal · unavailable");
    expect(rendered).toContain("Open Main Agent · unavailable");
    expect(rendered).toContain("Delete Topic · unavailable");
  });

  test("renders complete Topic details and live Main Agent and workspace states", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking", connected: true },
    });
    state = reduceDashboardEvent(state, {
      type: "terminal-opened",
      topicId: ID_A,
      result: { kind: "launched", workspace: 4, message: "Opened." },
    });
    state = handleDashboardInput(state, "\r").state;
    const detail = renderDashboard(state, 100, 24).join("\n");
    expect(detail).toContain("Base: /base/alpha");
    expect(detail).toContain("Worktree: /work/Alpha");
    expect(detail).toContain("Main Agent: thinking");
    expect(detail).toContain("Workspace: 4");

    for (const agentState of ["waiting-for-human", "stopped"] as const) {
      state = reduceDashboardEvent(state, {
        type: "main-agent-changed",
        agent: { topicId: ID_A, sessionId: ID_A, state: agentState, connected: false },
      });
      expect(renderDashboard(state, 100, 24).join("\n")).toContain(`Main Agent: ${agentState}`);
    }
  });

  test("renders narrow and wide dashboards without exceeding terminal width", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([
        topic(ID_A, "A-very-long-Topic-name-that-must-be-truncated"),
        topic(ID_B, "Beta", "setup-failed"),
      ]),
    );
    state = handleDashboardInput(state, "\r").state;
    for (const [width, height] of [
      [28, 12],
      [120, 30],
    ] as const) {
      const lines = renderDashboard(state, width, height);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
    }
  });
});

class FakeDashboardClient implements DashboardClient {
  closed = 0;
  handler: ((event: WorkEvent) => void) | undefined;
  disconnect: ((error: Error) => void) | undefined;
  createCalls: Array<{ input: NewTopic; requestId?: string }> = [];
  retryCalls: Array<{ topicId: string; requestId?: string }> = [];
  renameCalls: Array<{ topicId: string; name: string; requestId?: string }> = [];
  actionCalls: Array<{
    type: "delete" | "workspace" | "terminal" | "agent" | "reset-agent" | "pull-request";
    topicId: string;
    requestId?: string;
  }> = [];
  confirmCalls: Array<{ token: string; requestId?: string }> = [];
  rejectCalls: Array<{ token: string; requestId?: string }> = [];
  createResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  retryResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  renameResult: TopicMutationResult = { status: "renamed", topic: topic(ID_A, "Alpha") };
  confirmResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  rejectResult: TopicMutationResult = { status: "rejected", topicId: ID_A };
  private readonly topics: readonly TopicManifest[];

  constructor(topics: readonly TopicManifest[] = [topic(ID_A, "Alpha")]) {
    this.topics = topics;
  }

  async snapshot(): Promise<DaemonSnapshot> {
    return snapshot(this.topics);
  }

  async subscribe(handler: (event: WorkEvent) => void): Promise<void> {
    this.handler = handler;
  }

  async createTopic(input: NewTopic, requestId?: string): Promise<TopicMutationResult> {
    this.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
    return this.createResult;
  }

  async retryTopic(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.retryCalls.push({ topicId, ...(requestId === undefined ? {} : { requestId }) });
    return this.retryResult;
  }

  async renameTopic(
    topicId: string,
    name: string,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.renameCalls.push({ topicId, name, ...(requestId === undefined ? {} : { requestId }) });
    return this.renameResult;
  }

  async deleteTopic(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.actionCalls.push({
      type: "delete",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return {
      status: "confirmation-required",
      token: "delete-token",
      action: "topic.delete",
      topicId,
      expiresAt: "2026-01-01T00:01:00.000Z",
      text: "Delete only this local Topic record? The branch, worktree, base checkout, Pi session, and open windows will remain.",
    };
  }

  async accessWorkspace(topicId: string, requestId?: string): Promise<WorkspaceActionResult> {
    this.actionCalls.push({
      type: "workspace",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "focused", workspace: 3, message: "Focused Topic workspace 3." };
  }

  async openTerminal(topicId: string, requestId?: string): Promise<WorkActionResult> {
    this.actionCalls.push({
      type: "terminal",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Opened Topic terminal on workspace 3." };
  }

  async openMainAgent(
    topicId: string,
    requestId?: string,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    this.actionCalls.push({
      type: "agent",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Opened Main Agent on workspace 3." };
  }

  async resetMainAgent(
    topicId: string,
    requestId?: string,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    this.actionCalls.push({
      type: "reset-agent",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Started a new Main Agent." };
  }

  async openPullRequest(topicId: string, requestId?: string): Promise<WorkActionResult> {
    this.actionCalls.push({
      type: "pull-request",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "opened", message: "Opened the pull request in a browser." };
  }

  async confirm(token: string, requestId?: string): Promise<WorkActionResult> {
    this.confirmCalls.push({ token, ...(requestId === undefined ? {} : { requestId }) });
    return this.confirmResult;
  }

  async reject(token: string, requestId?: string): Promise<TopicMutationResult> {
    this.rejectCalls.push({ token, ...(requestId === undefined ? {} : { requestId }) });
    return this.rejectResult;
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnect = handler;
    return () => {
      this.disconnect = undefined;
    };
  }

  close(): void {
    this.closed += 1;
  }
}

describe("dashboard submission behavior", () => {
  test("returns to the dashboard, selects the added Topic, and prevents duplicate create", async () => {
    const client = new FakeDashboardClient([]);
    let finish!: (result: TopicMutationResult) => void;
    client.createTopic = async (input, requestId) => {
      client.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
      return new Promise<TopicMutationResult>((resolve) => {
        finish = resolve;
      });
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta-custom", "owner/beta");
    expect(component.snapshotState().wizard).toBeUndefined();
    expect(client.createCalls).toHaveLength(1);
    component.handleInput("a");
    component.handleInput("\r");
    expect(client.createCalls).toHaveLength(1);

    const provisioning = topic(ID_B, "Beta", "provisioning");
    client.handler?.({ type: "topic-added", topic: provisioning });
    expect(component.snapshotState().selectedTopicId).toBe(ID_B);
    expect(component.snapshotState().topics[0]?.setup.state).toBe("provisioning");
    client.handler?.({ type: "setup-changed", topic: topic(ID_B, "Beta", "ready") });
    expect(component.snapshotState().topics[0]?.setup.state).toBe("ready");
    client.handler?.({ type: "setup-changed", topic: topic(ID_B, "Beta", "setup-failed") });
    component.handleInput("\r");
    const failedDetails = renderDashboard(component.snapshotState(), 100, 20).join("\n");
    expect(failedDetails).toContain("setup-failed");
    expect(failedDetails).toContain("wt failed");
    finish({ status: "failed", reason: "wt failed", topic: topic(ID_B, "Beta", "setup-failed") });
    await Bun.sleep(0);
    expect(component.snapshotState().submissionInFlight).toBeUndefined();
    component.dispose();
  });

  test("uses one stable request id when a transport reconnect retries create", async () => {
    const first = new FakeDashboardClient([]);
    first.createTopic = async (input, requestId) => {
      first.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
      return new Promise<TopicMutationResult>(() => undefined);
    };
    const second = new FakeDashboardClient([]);
    const clients = [first, second];
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
      connect: async () => clients.shift()!,
      done: () => undefined,
    });
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta", "owner/beta");
    first.disconnect?.(new Error("socket lost"));
    await Bun.sleep(0);
    expect(first.createCalls).toHaveLength(1);
    expect(second.createCalls).toHaveLength(1);
    expect(second.createCalls[0]?.requestId).toBe(first.createCalls[0]?.requestId);
    component.dispose();
  });

  test("shows exact ask action and supports approve, reject, and deny", async () => {
    const ask = new FakeDashboardClient([]);
    ask.createResult = {
      status: "confirmation-required",
      token: "token-1",
      action: "repository.clone",
      topicId: ID_B,
      expiresAt: "2026-01-01T00:01:00.000Z",
      text: "Allow repository.clone for Topic Beta?",
    };
    const component = dashboardComponent(ask);
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    expect(component.render(80).join("\n")).toContain("Allow repository.clone for Topic Beta?");
    component.handleInput("y");
    await Bun.sleep(0);
    expect(ask.confirmCalls[0]?.token).toBe("token-1");
    component.dispose();

    const reject = new FakeDashboardClient([]);
    reject.createResult = { ...ask.createResult, token: "token-2" };
    const rejected = dashboardComponent(reject);
    await Bun.sleep(0);
    enterWizard(rejected, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    rejected.handleInput("n");
    await Bun.sleep(0);
    expect(reject.rejectCalls[0]?.token).toBe("token-2");
    rejected.dispose();

    const deny = new FakeDashboardClient([]);
    deny.createResult = {
      status: "denied",
      reason: "Policy denied repository.clone.",
      topic: topic(ID_B, "Beta", "setup-failed"),
    };
    const denied = dashboardComponent(deny);
    await Bun.sleep(0);
    enterWizard(denied, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    expect(denied.snapshotState().message).toBe("Policy denied repository.clone.");
    denied.dispose();
  });

  test("invokes workspace actions and shows workspace exhaustion as information", async () => {
    const client = new FakeDashboardClient();
    client.openTerminal = async (topicId, requestId) => {
      client.actionCalls.push({
        type: "terminal",
        topicId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return {
        kind: "unavailable",
        message: "No empty workspace is available in the temporary pool (1-10).",
      };
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.actionCalls[0]?.type).toBe("terminal");
    expect(component.snapshotState().message).toContain("No empty workspace");
    expect(component.snapshotState().phase).toBe("connected");
    component.dispose();
  });

  test("starts a new Main Agent from the action rail", async () => {
    const client = new FakeDashboardClient();
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    for (let index = 0; index < 3; index += 1) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(client.actionCalls[0]?.type).toBe("reset-agent");
    expect(component.snapshotState().message).toBe("Started a new Main Agent.");
    component.dispose();
  });

  test("retries an in-flight workspace action after reconnect with the same request id", async () => {
    const first = new FakeDashboardClient();
    first.openTerminal = async (topicId, requestId) => {
      first.actionCalls.push({
        type: "terminal",
        topicId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return new Promise<WorkActionResult>(() => undefined);
    };
    const second = new FakeDashboardClient();
    const clients = [first, second];
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
      connect: async () => clients.shift()!,
      done: () => undefined,
    });
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("\r");
    first.disconnect?.(new Error("socket lost"));
    await Bun.sleep(0);
    expect(second.actionCalls[0]?.type).toBe("terminal");
    expect(second.actionCalls[0]?.requestId).toBe(first.actionCalls[0]?.requestId);
    component.dispose();
  });

  test("shows policy denial as an unavailable action", async () => {
    const client = new FakeDashboardClient();
    client.openTerminal = async () => ({
      status: "denied",
      reason: "Policy denied terminal.open.",
      topic: topic(ID_A, "Alpha"),
    });
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(component.render(100).join("\n")).toContain("Open Terminal · unavailable");
    component.dispose();
  });

  test("shows the manifest-only delete warning and keeps nearest selection after deletion", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    const warning = component.render(180).join("\n");
    expect(warning).toContain("branch, worktree, base checkout, Pi session, and open windows");
    client.handler?.({ type: "topic-removed", topicId: ID_A });
    expect(component.snapshotState().selectedTopicId).toBe(ID_B);
    component.dispose();
  });

  test("offers Retry Setup for failed and interrupted Topics", async () => {
    for (const setup of ["setup-failed", "provisioning"] as const) {
      const client = new FakeDashboardClient([topic(ID_A, "Alpha", setup)]);
      const component = dashboardComponent(client);
      await Bun.sleep(0);
      component.handleInput("\r");
      expect(component.render(80).join("\n")).toContain("Retry Setup (r)");
      component.handleInput("r");
      component.handleInput("r");
      await Bun.sleep(0);
      expect(client.retryCalls).toHaveLength(1);
      component.dispose();
    }
  });

  test("renames a Topic through the actions prompt", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("Rename Topic");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("RENAME TOPIC");
    component.handleInput("2");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.renameCalls).toEqual([
      { topicId: ID_A, name: "Alpha2", requestId: expect.any(String) },
    ]);
    component.dispose();
  });

  test("cancels a rename with Escape and makes no request", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("RENAME TOPIC");
    component.handleInput("\x1b");
    await Bun.sleep(0);
    expect(client.renameCalls).toHaveLength(0);
    expect(component.render(80).join("\n")).not.toContain("RENAME TOPIC");
    component.dispose();
  });
});

describe("dashboard subscription lifecycle", () => {
  test("closes the subscription after Escape and session-style disposal", async () => {
    const first = new FakeDashboardClient();
    let done = 0;
    const tui = { terminal: { rows: 20 }, requestRender: () => undefined };
    const component = new WorkDashboardComponent({
      tui: tui as never,
      connect: async () => first,
      done: () => {
        done += 1;
      },
    });
    await Bun.sleep(0);
    component.handleInput("\x1b");
    expect(done).toBe(1);
    expect(first.closed).toBe(1);

    const second = new FakeDashboardClient();
    const shutdownComponent = new WorkDashboardComponent({
      tui: tui as never,
      connect: async () => second,
      done: () => undefined,
    });
    await Bun.sleep(0);
    shutdownComponent.dispose();
    shutdownComponent.dispose();
    expect(second.closed).toBe(1);
  });
});

function dashboardComponent(client: FakeDashboardClient): WorkDashboardComponent {
  return new WorkDashboardComponent({
    tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
    connect: async () => client,
    done: () => undefined,
  });
}

function enterWizard(
  component: WorkDashboardComponent,
  name: string,
  branch: string,
  repository: string,
): void {
  component.handleInput("a");
  component.handleInput(name);
  component.handleInput("\r");
  component.handleInput(repository);
  component.handleInput("\r");
  const generated = defaultBranchForTopicName(name);
  for (let index = 0; index < generated.length; index += 1) component.handleInput("\x7f");
  component.handleInput(branch);
  component.handleInput("\r");
  component.handleInput("\r");
}
