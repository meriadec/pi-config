import { describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  Branch,
  ClientId,
  Repository,
  TopicId,
  type DurableOperationResult,
} from "../domain/index.ts";
import type { WorkSnapshot, WorkStreamItem } from "../application/state/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import { EffectWorkDashboardComponent } from "./effect-dashboard-component.ts";
import {
  handleDashboardViewInput,
  initialDashboardViewState,
  reconcileDashboardSelection,
  renderDashboardView,
} from "./dashboard-view.ts";

const topicId = TopicId.make("10000000-0000-4000-8000-000000000001");
const childId = TopicId.make("10000000-0000-4000-8000-000000000002");

function snapshot(): WorkSnapshot {
  const topic = {
    name: "Alpha",
    repository: Repository.make("owner/repo"),
    setup: {
      state: "ready" as const,
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: AbsolutePath.make("/tmp/alpha"),
    mainAgent: { sessionId: "session", sessionFile: null },
    partition: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  return {
    daemon: { id: "daemon", startedAt: "2026-01-01T00:00:00.000Z" },
    revision: 0,
    durable: {
      topics: [
        { rowRevision: 0, topic: { ...topic, id: topicId, branch: Branch.make("alpha") } },
        {
          rowRevision: 0,
          topic: {
            ...topic,
            id: childId,
            name: "Checkpoint",
            branch: Branch.make("checkpoint"),
            parentTopicId: topicId,
            integrationTarget: { kind: "integration-branch" },
            chainState: "active",
          },
        },
      ],
      repositoryStates: [],
      operations: [],
    },
    observed: {
      topics: [
        {
          topicId,
          freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
          value: {
            topicId,
            integrationStatus: "behind",
            gitOperationState: "none",
            worktreePresent: true,
            worktreeClean: true,
            orphan: false,
            mainAgentActivity: "thinking",
          },
        },
      ],
      pullRequests: [],
      diagnostics: [],
      activeActions: [],
    },
  };
}

class FakeRuntime {
  stateHandler: ((item: WorkStreamItem) => void) | undefined;
  actions: Array<{ action: string; topicId?: TopicId }> = [];
  commands: unknown[] = [];
  readonly runtime = {
    clientId: ClientId.make("50000000-0000-4000-8000-000000000001"),
    subscribeState: (handler: (item: WorkStreamItem) => void) => {
      this.stateHandler = handler;
      return () => undefined;
    },
    watchOperation: () => () => undefined,
    repeat: () => () => undefined,
    ephemeralAction: async (action: string, selected?: TopicId) => {
      this.actions.push({ action, ...(selected === undefined ? {} : { topicId: selected }) });
    },
    mainAgentCall: async () => undefined,
    atomicCommand: async (command: unknown): Promise<DurableOperationResult> => {
      this.commands.push(command);
      return { version: 1, status: "succeeded", value: {} };
    },
    dispose: async () => undefined,
  } as unknown as WorkClientRuntime;
}

describe("Effect dashboard product UI", () => {
  test("renders the Topic table, hierarchy, status styling, and detail action rail", () => {
    let state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const list = renderDashboardView(state, snapshot(), 120, 30).join("\n");
    expect(list).toContain("Alpha");
    expect(list).toContain("└─ Checkpoint");
    expect(list).toContain("thinking");
    expect(list).toContain("J/K move Partition");

    state = handleDashboardViewInput(state, snapshot(), "l").state;
    state = handleDashboardViewInput(state, snapshot(), "l").state;
    const details = renderDashboardView(state, snapshot(), 120, 30).join("\n");
    expect(details).toContain("Repository: owner/repo");
    expect(details).toContain("> Copy Branch Name");
    expect(details).toContain("Open Main Agent");
    expect(details).toContain("Rebase onto Integration Target");
    expect(details).toContain("Delete Topic");
  });

  test("fills the available terminal height", () => {
    const lines = renderDashboardView(initialDashboardViewState(), snapshot(), 120, 30);

    expect(lines).toHaveLength(30);
  });

  test("keeps the previous wide Topic column order", () => {
    const current = snapshot();
    const withNote: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((entry, index) =>
          index === 0 ? { ...entry, topic: { ...entry.topic, note: "Focus" } } : entry,
        ),
      },
    };
    const header = renderDashboardView(initialDashboardViewState(), withNote, 120, 30)[1]!;
    const columns = ["\uF47F", "TOPIC", "NOTE", "REPOSITORY", "PR", "SETUP", "MAIN AGENT"];
    let previousPosition = -1;

    for (const column of columns) {
      const position = header.indexOf(column);
      expect(position).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
  });

  test("uses the previous subtle background for the selected Topic row", () => {
    const state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const row = renderDashboardView(state, snapshot(), 120, 30).find((line) =>
      line.includes("Alpha"),
    );

    expect(row).toStartWith("\x1b[48;2;59;66;82m");
    expect(row).toEndWith("\x1b[49m");
  });

  test("keeps Notes, confirmations, and direct shortcuts in the pure input model", () => {
    let state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    state = handleDashboardViewInput(state, snapshot(), "n").state;
    state = handleDashboardViewInput(state, snapshot(), "Ready").state;
    const note = handleDashboardViewInput(state, snapshot(), "\r");
    expect(note.action).toEqual({ _tag: "SetNote", topicId, note: "Ready" });

    const rebase = handleDashboardViewInput(note.state, snapshot(), "s");
    expect(rebase.action).toEqual({ _tag: "Rebase", topicId });
  });

  test("drives the production component instead of a flat placeholder", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      copyToClipboard: async () => undefined,
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("l");
    component.handleInput("l");
    const screenLines = component.render(120);
    const screen = screenLines.join("\n");
    expect(screenLines).toHaveLength(30);
    expect(screen).toContain("Copy Branch Name");
    expect(screen).toContain("Open Topic Workspace");
    component.handleInput("o");
    await Promise.resolve();
    expect(fake.actions).toContainEqual({ action: "workspace", topicId });
    await component.dispose();
  });
});
