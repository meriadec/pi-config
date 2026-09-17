import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
  AbsolutePath,
  Branch,
  ClientId,
  Repository,
  OperationId,
  TopicId,
  type DurableOperationResult,
  type MainAgentActivity,
} from "../domain/index.ts";
import type { WorkSnapshot, WorkStreamItem } from "../application/state/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import type { WorkConfiguration } from "../infrastructure/config.ts";
import {
  createParentBranchScenario,
  createTemporaryRoot,
  removeTemporaryRoots,
} from "../test-support/git-repository.ts";
import { EffectWorkDashboardComponent } from "./effect-dashboard-component.ts";
import {
  calculateDashboardLayout,
  handleDashboardViewInput,
  initialDashboardViewState,
  reconcileDashboardSelection,
  renderDashboardView,
  topicActions,
  updateDashboardEditorValue,
} from "./dashboard-view.ts";
import { mainAgentDisplayLabel } from "./main-agent-display.ts";

const topicId = TopicId.make("10000000-0000-4000-8000-000000000001");
const childId = TopicId.make("10000000-0000-4000-8000-000000000002");
const terminalOperationId = OperationId.make("20000000-0000-4000-8000-000000000001");
const dashboardConfiguration: WorkConfiguration = {
  version: 2,
  workBase: AbsolutePath.make("/tmp/work"),
  policies: {
    defaults: {
      "repository.clone": "allow",
      "topic.create-worktree": "allow",
      "topic.run-setup": "allow",
      "terminal.open": "allow",
      "agent.open": "allow",
      "agent.reset": "ask",
      "topic.delete": "ask",
    },
    repositories: {},
    topics: {},
  },
  repositories: {
    [Repository.make("LedgerHQ/app-bitcoin")]: { setupCommands: [] },
    [Repository.make("LedgerHQ/ledger-live")]: { setupCommands: [] },
    [Repository.make("owner/repo")]: { setupCommands: [] },
  },
};

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
      repositoryStates: [
        {
          repository: Repository.make("owner/repo"),
          integrationBranch: Branch.make("main"),
          source: "inferred",
          inferredIntegrationBranch: Branch.make("main"),
          rowRevision: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      operations: [],
    },
    observed: {
      topics: [
        {
          topicId,
          freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
          value: {
            topicId,
            integrationStatus: {
              kind: "behind",
              target: Branch.make("main"),
              ahead: 2,
              behind: 1,
            },
            checkedOutBranch: Branch.make("alpha"),
            gitOperationConflict: null,
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

function withMainAgentActivity(activity: MainAgentActivity): WorkSnapshot {
  const current = snapshot();
  return {
    ...current,
    observed: {
      ...current.observed,
      topics: current.observed.topics.map((entry) => ({
        ...entry,
        value:
          entry.value === undefined ? undefined : { ...entry.value, mainAgentActivity: activity },
      })),
    },
  };
}

function stripSgr(value: string): string {
  const escape = String.fromCharCode(27);
  let plain = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === escape && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") index += 1;
    } else {
      plain += value[index];
    }
  }
  return plain;
}

class FakeRuntime {
  stateHandler: ((item: WorkStreamItem) => void) | undefined;
  actions: Array<{ action: string; topicId?: TopicId }> = [];
  commands: unknown[] = [];
  starts: unknown[] = [];
  confirms: string[] = [];
  rejects: string[] = [];
  cancellationRequests: OperationId[] = [];
  chainConfirmation: string | undefined;
  repeats: Array<() => void> = [];
  repeatStops = 0;
  schedules: Array<() => void> = [];
  scheduleIntervals: number[] = [];
  scheduleStops = 0;
  awaitOperationCalls = 0;
  awaitOperationPending = false;
  ephemeralResult: unknown;
  askFor:
    | "terminal.open"
    | "agent.open"
    | "agent.reset"
    | "topic.delete"
    | "topic.provision"
    | undefined;
  readonly runtime = {
    clientId: ClientId.make("50000000-0000-4000-8000-000000000001"),
    subscribeState: (handler: (item: WorkStreamItem) => void) => {
      this.stateHandler = handler;
      return () => undefined;
    },
    watchOperation: () => () => undefined,
    repeat: (_interval: number, task: () => void) => {
      this.repeats.push(task);
      return () => {
        this.repeatStops += 1;
      };
    },
    schedule: (delay: number, task: () => void) => {
      let active = true;
      this.scheduleIntervals.push(delay);
      this.schedules.push(() => {
        if (active) task();
      });
      return () => {
        active = false;
        this.scheduleStops += 1;
      };
    },
    startOperation: async (request: unknown) => {
      this.starts.push(request);
      const kind = (request as { input: { kind: string } }).input.kind;
      return this.askFor === kind
        ? {
            id: terminalOperationId,
            state: "awaiting-confirmation" as const,
            confirmation: "direct-secret",
          }
        : { id: terminalOperationId, state: "running" as const };
    },
    requestOperationCancellation: async (id: OperationId) => {
      this.cancellationRequests.push(id);
      return { confirmation: "cancel-secret" };
    },
    confirmOperation: async (id: OperationId, confirmation: string) => {
      this.confirms.push(`${id}:${confirmation}`);
      return {
        id,
        topicId,
        state: "cancelled",
        phase: "cancelled",
        input: { version: 1, kind: "topic.provision", value: {} },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        revision: 1,
      } as never;
    },
    rejectOperation: async (id: OperationId) => {
      this.rejects.push(id);
      return {} as never;
    },
    awaitOperation: async () => {
      this.awaitOperationCalls += 1;
      if (this.awaitOperationPending) await new Promise<never>(() => undefined);
      return { result: { version: 1, status: "succeeded", value: {} } } as never;
    },
    ephemeralAction: async (action: string, selected?: TopicId) => {
      this.actions.push({ action, ...(selected === undefined ? {} : { topicId: selected }) });
      return this.ephemeralResult;
    },
    mainAgentCall: async () => undefined,
    atomicCommand: async (command: unknown): Promise<DurableOperationResult> => {
      this.commands.push(command);
      if (
        this.chainConfirmation !== undefined &&
        (command as { _tag?: string; confirmed?: boolean })._tag === "MoveInChain" &&
        (command as { confirmed?: boolean }).confirmed !== true
      ) {
        throw { reason: "confirmation-required", message: this.chainConfirmation };
      }
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
    expect(stripSgr(list)).toContain("thinking");
    expect(list).toContain("J/K move Partition");

    state = handleDashboardViewInput(state, snapshot(), "l").state;
    state = handleDashboardViewInput(state, snapshot(), "l").state;
    const details = renderDashboardView(state, snapshot(), 120, 30).join("\n");
    expect(details).toContain("Repository: owner/repo");
    expect(details).toContain("> Copy Branch Name");
    expect(details).toContain("Open Main Agent");
    expect(details).toContain("Rebase onto Integration Target");
    expect(details).toContain("Delete Topic");
    expect(details).toContain("Integration: behind · ahead 2 · behind 1");
    expect(details).toContain("Integration Target: main");
    expect(details).toContain("Integration Branch: main");
  });

  test("keeps stale Topics visible with complete bounded live status detail", () => {
    const base = snapshot();
    const current: WorkSnapshot = {
      ...base,
      durable: {
        ...base.durable,
        operations: [
          {
            id: terminalOperationId,
            topicId,
            state: "running",
            phase: "setup command 2",
            input: { version: 1, kind: "topic.provision", value: {} },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
            rowRevision: 1,
          },
        ],
      },
      observed: {
        ...base.observed,
        topics: [
          {
            ...base.observed.topics[0]!,
            freshness: {
              _tag: "Failed",
              failedAt: "2026-01-01T00:02:00.000Z",
              message: "Local observation failed.",
            },
            value: {
              ...base.observed.topics[0]!.value!,
              baseCheckout: AbsolutePath.make("/tmp/repo"),
              workspace: 4,
              gitOperationState: "cherry-pick",
              gitOperationConflict: true,
            },
          },
        ],
        activeActions: [
          {
            id: `rebase:${topicId}`,
            kind: "topic.rebase",
            topicId,
            startedAt: "2026-01-01T00:01:00.000Z",
          },
        ],
      },
    };
    const selected = reconcileDashboardSelection(initialDashboardViewState(), current);
    const reconnecting = renderDashboardView(
      selected,
      current,
      160,
      30,
      "Reconnecting to pi-workd…",
    ).join("\n");
    expect(reconnecting).toContain("Alpha");
    expect(reconnecting).toContain("Reconnecting to pi-workd");
    expect(stripSgr(reconnecting)).toContain("cherry-pick conflict");

    const details = renderDashboardView(
      { ...selected, sidebarOpen: true, focus: "actions", pending: new Set([topicId]) },
      current,
      160,
      30,
    ).join("\n");
    for (const detail of [
      "Base checkout: /tmp/repo",
      "Worktree: /tmp/alpha",
      "Workspace: 4",
      "Setup operation: running · setup command 2",
      "Operation: running · setup command 2",
      "Active command: topic.rebase",
      "Observation: Observation failed 2026-01-01T00:02:00",
      "Git operation: ",
      "Main Agent:",
      "Diagnostic: Local observation failed.",
    ])
      expect(stripSgr(details)).toContain(detail);

    const orphan = {
      ...current,
      observed: {
        ...current.observed,
        topics: current.observed.topics.map((entry) => ({
          ...entry,
          value: { ...entry.value!, orphan: true, gitOperationState: "none" as const },
        })),
      },
    };
    const orphanRow = renderDashboardView(selected, orphan, 160, 30).find((line) =>
      line.includes("Alpha"),
    );
    expect(stripSgr(orphanRow!)).toContain("orphan");
    expect(orphanRow).toContain("\x1b[91m");
  });

  test("renders previous Main Agent labels, palettes, and the same detail activity", () => {
    expect(mainAgentDisplayLabel("thinking-sub")).toBe("thinking (sub)");

    const delegated = withMainAgentActivity("thinking-sub");
    let state = {
      ...reconcileDashboardSelection(initialDashboardViewState(), delegated),
      shimmerPhase: 1,
    };
    const delegatedList = renderDashboardView(state, delegated, 140, 30).join("\n");
    expect(stripSgr(delegatedList)).toContain("thinking (sub)");
    expect(delegatedList).toContain("\x1b[38;5;231m");

    state = handleDashboardViewInput(state, delegated, "l").state;
    const delegatedDetails = renderDashboardView(state, delegated, 140, 30).join("\n");
    expect(stripSgr(delegatedDetails)).toContain("Main Agent: thinking (sub)");

    const tracking = withMainAgentActivity("tracking-pr");
    const trackingList = renderDashboardView(state, tracking, 140, 30).join("\n");
    expect(trackingList).toContain("\x1b[38;5;195m");
    expect(trackingList).not.toEqual(delegatedList);

    for (const activity of ["starting", "idle", "waiting-for-human", "failed"] as const) {
      const current = withMainAgentActivity(activity);
      expect(stripSgr(renderDashboardView(state, current, 140, 30).join("\n"))).toContain(
        `Main Agent: ${activity}`,
      );
    }
  });

  test("carries the Effect-owned shimmer phase into component rendering", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    const delegated = withMainAgentActivity("thinking-sub");
    fake.stateHandler!({ _tag: "Snapshot", snapshot: delegated });
    const first = component.render(140).find((line) => line.includes("Alpha"));

    expect(fake.repeats).toHaveLength(1);
    fake.repeats[0]!();
    expect(component.snapshotViewState().shimmerPhase).toBe(1);
    expect(component.render(140).find((line) => line.includes("Alpha"))).not.toEqual(first);

    await component.dispose();
    expect(fake.repeatStops).toBe(1);
  });

  test("renders and controls the complete pull request path", () => {
    const base = snapshot();
    const current: WorkSnapshot = {
      ...base,
      durable: {
        ...base.durable,
        topics: base.durable.topics.map((row) =>
          row.topic.id === topicId
            ? { ...row, topic: { ...row.topic, pullRequest: { number: 7 } } }
            : row,
        ),
      },
      observed: {
        ...base.observed,
        pullRequests: [
          {
            topicId,
            freshness: {
              _tag: "Failed",
              failedAt: "2026-01-01T00:00:01.000Z",
              message: "GitHub response was malformed.",
            },
            value: {
              identity: { number: 7 },
              url: "https://github.com/owner/repo/pull/7",
              state: "open",
              draft: false,
              ci: "passing",
              reviewPending: false,
              copilotReviewed: true,
              changesRequested: false,
              approved: true,
              unresolvedThreads: 0,
            },
          },
        ],
      },
    };
    let state = reconcileDashboardSelection(initialDashboardViewState(), current);
    const list = renderDashboardView(state, current, 160, 30).join("\n");
    expect(list).toContain("\x1b[4m");
    expect(list).toContain("#7");
    expect(list).toContain("approved");
    expect(handleDashboardViewInput(state, current, "p").action).toEqual({
      _tag: "OpenPullRequest",
      topicId,
    });

    state = handleDashboardViewInput(state, current, "l").state;
    const details = renderDashboardView(state, current, 160, 30).join("\n");
    expect(details).toContain("PR lifecycle: open");
    expect(details).toContain("PR CI: passing");
    expect(details).toContain("PR review: approved");
    expect(details).toContain("PR diagnostic: GitHub response was malformed.");
    expect(details).toContain("Open Pull Request in Browser");
    expect(handleDashboardViewInput(state, current, "p").action).toBeUndefined();

    const absent = snapshot();
    const absentState = reconcileDashboardSelection(initialDashboardViewState(), absent);
    expect(handleDashboardViewInput(absentState, absent, "p").state.message).toBe(
      "The Topic has no pull request.",
    );
    expect(
      topicActions(absentState, absent).some((item) => item.action._tag === "OpenPullRequest"),
    ).toBe(false);
  });

  test("keeps durable pull request identity visible while restart observation is pending", () => {
    const base = snapshot();
    const restarted: WorkSnapshot = {
      ...base,
      durable: {
        ...base.durable,
        topics: base.durable.topics.map((row) =>
          row.topic.id === topicId
            ? { ...row, topic: { ...row.topic, pullRequest: { number: 42 } } }
            : row,
        ),
      },
    };
    const state = reconcileDashboardSelection(initialDashboardViewState(), restarted);
    expect(renderDashboardView(state, restarted, 160, 30).join("\n")).toContain("#42");
    expect(topicActions(state, restarted).map((action) => action.label)).toContain(
      "Open Pull Request in Browser",
    );
  });

  test("shows and confirms Integration Branch reset only for inferred state", () => {
    const inferred = snapshot();
    let state = reconcileDashboardSelection(initialDashboardViewState(), inferred);
    state = handleDashboardViewInput(state, inferred, "l").state;
    state = handleDashboardViewInput(state, inferred, "l").state;
    const actions = topicActions(state, inferred);
    const resetIndex = actions.findIndex((item) => item.action._tag === "ResetIntegrationBranch");
    expect(resetIndex).toBeGreaterThanOrEqual(0);
    state = { ...state, focusedAction: resetIndex };
    const confirmation = handleDashboardViewInput(state, inferred, "\r");
    expect(confirmation.state.confirmation?.text).toBe(
      "Reset the inferred Integration Branch for owner/repo? " +
        "No Branch moves and no Git history changes.",
    );

    const configured: WorkSnapshot = {
      ...inferred,
      durable: {
        ...inferred.durable,
        repositoryStates: [
          {
            repository: Repository.make("owner/repo"),
            integrationBranch: Branch.make("trunk"),
            source: "configured",
            rowRevision: 0,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    state = reconcileDashboardSelection(initialDashboardViewState(), configured);
    state = handleDashboardViewInput(state, configured, "l").state;
    expect(
      topicActions(state, configured).some((item) => item.action._tag === "ResetIntegrationBranch"),
    ).toBe(false);
    expect(renderDashboardView(state, configured, 120, 30).join("\n")).toContain(
      "Integration Branch: trunk (configured)",
    );
  });

  test("orders Partitions, active families, durable children, and pending positions", () => {
    const current = snapshot();
    const root = current.durable.topics[0]!;
    const child = current.durable.topics[1]!;
    const laterChildId = TopicId.make("10000000-0000-4000-8000-000000000003");
    const pendingChildId = TopicId.make("10000000-0000-4000-8000-000000000004");
    const inactiveRootId = TopicId.make("10000000-0000-4000-8000-000000000005");
    const earlierPartitionId = TopicId.make("10000000-0000-4000-8000-000000000006");
    const ordered: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: [
          root,
          child,
          {
            rowRevision: 0,
            topic: {
              ...child.topic,
              id: laterChildId,
              name: "Aardvark child",
              branch: Branch.make("later-child"),
              integrationTarget: { kind: "topic", topicId: childId },
            },
          },
          {
            rowRevision: 0,
            topic: {
              ...child.topic,
              id: pendingChildId,
              name: "Pending child",
              branch: Branch.make("pending-child"),
              chainState: "pending",
              integrationTarget: { kind: "integration-branch" },
            },
          },
          {
            rowRevision: 0,
            topic: {
              ...root.topic,
              id: inactiveRootId,
              name: "Aardvark root",
              branch: Branch.make("inactive-root"),
            },
          },
          {
            rowRevision: 0,
            topic: {
              ...root.topic,
              id: earlierPartitionId,
              name: "Earlier Partition",
              branch: Branch.make("earlier-partition"),
              partition: -1,
            },
          },
        ],
      },
      observed: {
        ...current.observed,
        topics: [
          ...current.observed.topics,
          {
            topicId: pendingChildId,
            freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
            value: {
              topicId: pendingChildId,
              integrationStatus: { kind: "conflict" },
              gitOperationState: "none",
              worktreePresent: true,
              worktreeClean: true,
              orphan: false,
            },
          },
          {
            topicId: childId,
            freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
            value: {
              topicId: childId,
              integrationStatus: { kind: "current" },
              gitOperationState: "none",
              worktreePresent: true,
              worktreeClean: true,
              orphan: false,
            },
          },
        ],
      },
    };

    const rendered = renderDashboardView(initialDashboardViewState(), ordered, 120, 30).join("\n");
    const names = [
      "Earlier Partition",
      "Alpha",
      "Pending child",
      "Checkpoint",
      "Aardvark child",
      "Aardvark root",
    ];
    expect(names.map((name) => rendered.indexOf(name))).toEqual(
      names.map((name) => rendered.indexOf(name)).toSorted((left, right) => left - right),
    );
    expect(rendered).toContain("\x1b[31m\uF071\x1b[39m");
    expect(rendered).toContain("\x1b[32m\uF058\x1b[39m");
  });

  test("reports all observed rebase guards before invocation", () => {
    const current = snapshot();
    const guarded: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((row) =>
          row.topic.id === topicId
            ? {
                ...row,
                topic: {
                  ...row.topic,
                  integrationTarget: { kind: "topic", topicId: childId },
                },
              }
            : row,
        ),
      },
      observed: {
        ...current.observed,
        topics: [
          {
            ...current.observed.topics[0]!,
            value: {
              ...current.observed.topics[0]!.value!,
              orphan: true,
              worktreeClean: false,
              checkedOutBranch: Branch.make("other"),
              gitOperationState: "rebase",
              gitOperationConflict: true,
            },
          },
          {
            topicId: childId,
            freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
            value: {
              topicId: childId,
              integrationStatus: { kind: "current" },
              gitOperationState: "merge",
              worktreePresent: true,
              worktreeClean: true,
              orphan: false,
            },
          },
        ],
        pullRequests: [
          {
            topicId,
            freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:00.000Z" },
            value: {
              identity: { number: 42 },
              url: "https://github.com/owner/repo/pull/42",
              state: "open",
              draft: false,
              ci: "passing",
              reviewPending: false,
              copilotReviewed: false,
              changesRequested: false,
              approved: true,
              unresolvedThreads: 0,
            },
          },
        ],
      },
    };
    const action = topicActions(
      { ...initialDashboardViewState(), selectedTopicId: topicId },
      guarded,
    ).find((item) => item.action._tag === "Rebase")!;

    expect(action.available).toBe(false);
    for (const reason of [
      "Worktree is missing",
      "Open pull request #42",
      "rebase conflict",
      "Worktree has local changes",
      "Checked-out Branch is other",
      "Integration Target has merge in progress",
      "Main Agent is thinking",
    ])
      expect(action.reason).toContain(reason);
  });

  test("offers Add Child Topic only for an available root Parent Topic", () => {
    const current = snapshot();
    const rootState = {
      ...reconcileDashboardSelection(initialDashboardViewState(), current),
      creationAvailable: true,
    };
    expect(topicActions(rootState, current).map((action) => action.label)).toContain(
      "Add Child Topic",
    );
    expect(
      topicActions({ ...rootState, selectedTopicId: childId }, current).map(
        (action) => action.label,
      ),
    ).not.toContain("Add Child Topic");
    expect(
      topicActions({ ...rootState, creationAvailable: false }, current).map(
        (action) => action.label,
      ),
    ).not.toContain("Add Child Topic");
    const unavailable: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((row) =>
          row.topic.id === topicId ? { ...row, topic: { ...row.topic, worktreePath: null } } : row,
        ),
      },
    };
    expect(topicActions(rootState, unavailable).map((action) => action.label)).not.toContain(
      "Add Child Topic",
    );
  });

  test("offers and submits bounded Parent Topic relationship actions", async () => {
    const current = snapshot();
    const root = current.durable.topics[0]!;
    const adopterId = TopicId.make("10000000-0000-4000-8000-000000000003");
    const secondId = TopicId.make("10000000-0000-4000-8000-000000000004");
    const otherRepositoryId = TopicId.make("10000000-0000-4000-8000-000000000005");
    const withCandidates: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: [
          ...current.durable.topics,
          {
            rowRevision: 0,
            topic: {
              ...root.topic,
              id: adopterId,
              name: "Adopter",
              branch: Branch.make("adopter"),
              partition: 1,
              integrationTarget: { kind: "integration-branch" },
            },
          },
          {
            rowRevision: 0,
            topic: {
              ...root.topic,
              id: secondId,
              name: "Second family",
              branch: Branch.make("second-family"),
              partition: 2,
              integrationTarget: { kind: "integration-branch" },
            },
          },
          {
            rowRevision: 0,
            topic: {
              ...root.topic,
              id: otherRepositoryId,
              name: "Other repository",
              branch: Branch.make("other-repository"),
              repository: Repository.make("owner/other"),
              integrationTarget: { kind: "integration-branch" },
            },
          },
        ],
      },
    };
    const childState = {
      ...initialDashboardViewState(),
      selectedTopicId: childId,
      sidebarOpen: true,
      focus: "actions" as const,
    };
    expect(topicActions(childState, withCandidates).map((item) => item.label)).toEqual(
      expect.arrayContaining(["Change Parent Topic", "Remove Parent Topic"]),
    );
    expect(
      topicActions({ ...childState, selectedTopicId: topicId }, withCandidates).map(
        (item) => item.label,
      ),
    ).not.toContain("Change Parent Topic");

    const changeIndex = topicActions(childState, withCandidates).findIndex(
      (item) => item.action._tag === "ChooseParent",
    );
    let chooser = handleDashboardViewInput(
      { ...childState, focusedAction: changeIndex },
      withCandidates,
      "\r",
    ).state;
    const rendered = renderDashboardView(chooser, withCandidates, 80, 20).join("\n");
    expect(rendered).toContain("CHANGE PARENT TOPIC · Checkpoint");
    expect(rendered).toContain("Adopter");
    expect(rendered).toContain("Second family");
    expect(rendered).not.toContain("Other repository");
    expect(rendered).not.toContain("> Alpha");

    chooser = handleDashboardViewInput(chooser, withCandidates, "k").state;
    expect(chooser.parentChooser?.index).toBe(0);
    chooser = handleDashboardViewInput(chooser, withCandidates, "\x1b[B").state;
    chooser = handleDashboardViewInput(chooser, withCandidates, "j").state;
    expect(chooser.parentChooser?.index).toBe(1);
    const submitted = handleDashboardViewInput(chooser, withCandidates, "\r");
    expect(submitted.action).toEqual({
      _tag: "ChangeParent",
      topicId: childId,
      parentTopicId: secondId,
    });

    const cancelled = handleDashboardViewInput(
      { ...chooser, parentChooser: { ...chooser.parentChooser!, index: 0 } },
      withCandidates,
      "\x1b",
    );
    expect(cancelled.state.parentChooser).toBeUndefined();
    expect(cancelled.action).toBeUndefined();

    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: withCandidates });
    component.handleInput("j");
    component.handleInput("\r");
    const componentChangeIndex = topicActions(
      component.snapshotViewState(),
      withCandidates,
    ).findIndex((item) => item.action._tag === "ChooseParent");
    while (component.snapshotViewState().focusedAction !== componentChangeIndex) {
      component.handleInput("j");
    }
    component.handleInput("\r");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toContainEqual({
      _tag: "ChangeParent",
      topicId: childId,
      parentTopicId: secondId,
    });
    component.handleInput("\r");
    const removeIndex = topicActions(component.snapshotViewState(), withCandidates).findIndex(
      (item) => item.action._tag === "RemoveParent",
    );
    while (component.snapshotViewState().focusedAction !== removeIndex) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toContainEqual({ _tag: "RemoveParent", topicId: childId });
    expect(component.snapshotViewState().selectedTopicId).toBe(childId);
    await component.dispose();
  });

  test("offers chain maintenance, bounds target selection, and confirms only a broken move", async () => {
    const current = snapshot();
    const parent = current.durable.topics[0]!;
    const first = current.durable.topics[1]!;
    const secondId = TopicId.make("10000000-0000-4000-8000-000000000006");
    const family: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: [
          {
            ...parent,
            topic: {
              ...parent.topic,
              integrationTarget: { kind: "topic", topicId: secondId },
            },
          },
          first,
          {
            rowRevision: 0,
            topic: {
              ...first.topic,
              id: secondId,
              name: "Review",
              branch: Branch.make("review"),
              integrationTarget: { kind: "topic", topicId: childId },
            },
          },
        ],
      },
    };
    const childState = {
      ...initialDashboardViewState(),
      selectedTopicId: childId,
      sidebarOpen: true,
      focus: "actions" as const,
    };
    const childActions = topicActions(childState, family);
    expect(childActions.map((item) => item.label)).toContain("Move in Integration Chain");
    expect(childActions.map((item) => item.label)).not.toContain("Reset Integration Target");
    expect(
      topicActions({ ...childState, selectedTopicId: topicId }, family).map((item) => item.label),
    ).toContain("Reset Integration Target");

    const moveIndex = childActions.findIndex((item) => item.action._tag === "ChooseChainTarget");
    let chooser = handleDashboardViewInput(
      { ...childState, focusedAction: moveIndex },
      family,
      "\r",
    ).state;
    const rendered = renderDashboardView(chooser, family, 80, 20).join("\n");
    expect(rendered).toContain("MOVE IN INTEGRATION CHAIN · Checkpoint");
    expect(rendered).toContain("main (first in the chain)");
    expect(rendered).toContain("After Review");
    chooser = handleDashboardViewInput(chooser, family, "\x1b[B").state;
    expect(handleDashboardViewInput(chooser, family, "\r").action).toEqual({
      _tag: "MoveInChain",
      topicId: childId,
      target: { kind: "topic", topicId: secondId },
    });
    expect(handleDashboardViewInput(chooser, family, "\x1b").action).toBeUndefined();

    const fake = new FakeRuntime();
    fake.chainConfirmation = "The move needs a rebase: Review does not contain Checkpoint.";
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: family });
    component.handleInput("j");
    component.handleInput("\r");
    while (
      topicActions(component.snapshotViewState(), family)[
        component.snapshotViewState().focusedAction
      ]?.action._tag !== "ChooseChainTarget"
    ) {
      component.handleInput("j");
    }
    component.handleInput("\r");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(component.snapshotViewState().confirmation?.text).toBe(fake.chainConfirmation);
    expect(fake.commands).toHaveLength(1);
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toEqual([
      { _tag: "MoveInChain", topicId: childId, target: { kind: "topic", topicId: secondId } },
      {
        _tag: "MoveInChain",
        topicId: childId,
        target: { kind: "topic", topicId: secondId },
        confirmed: true,
      },
    ]);
    expect(component.snapshotViewState().confirmation).toBeUndefined();
    component.handleInput("k");
    component.handleInput("\r");
    while (
      topicActions(component.snapshotViewState(), family)[
        component.snapshotViewState().focusedAction
      ]?.action._tag !== "ResetIntegrationTarget"
    ) {
      component.handleInput("j");
    }
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands.at(-1)).toEqual({
      _tag: "ResetIntegrationTarget",
      topicId,
    });
    await component.dispose();
  });

  test("offers Retry Setup only after failure or interruption with exact blocked reasons", () => {
    const current = snapshot();
    const withSetupState = (state: "setup-failed" | "setup-interrupted"): WorkSnapshot => ({
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((row) =>
          row.topic.id === topicId
            ? { ...row, topic: { ...row.topic, setup: { ...row.topic.setup, state } } }
            : row,
        ),
      },
    });
    const failed = withSetupState("setup-failed");
    const view = reconcileDashboardSelection(initialDashboardViewState(), failed);
    expect(topicActions(view, current).some((item) => item.label === "Retry Setup")).toBeFalse();
    expect(topicActions(view, failed).find((item) => item.label === "Retry Setup")).toMatchObject({
      available: true,
      action: { _tag: "RetrySetup", topicId },
    });
    expect(
      topicActions(view, withSetupState("setup-interrupted")).some(
        (item) => item.label === "Retry Setup",
      ),
    ).toBeTrue();

    const denied: WorkSnapshot = {
      ...failed,
      observed: {
        ...failed.observed,
        policies: [
          { action: "topic.run-setup", decision: "deny", scope: { kind: "topic", topicId } },
        ],
      },
    };
    expect(topicActions(view, denied).find((item) => item.label === "Retry Setup")).toMatchObject({
      available: false,
      reason: "Denied by topic.run-setup Action policy",
    });

    const active: WorkSnapshot = {
      ...failed,
      durable: {
        ...failed.durable,
        operations: [
          {
            id: terminalOperationId,
            topicId,
            state: "running",
            phase: "setup 1/2",
            input: { version: 1, kind: "topic.provision", value: {} },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            rowRevision: 1,
          },
        ],
      },
    };
    expect(topicActions(view, active).find((item) => item.label === "Retry Setup")).toMatchObject({
      available: false,
      reason: "Topic work is active",
    });
    expect(topicActions(view, active).find((item) => item.label === "Cancel Setup")).toEqual({
      label: "Cancel Setup",
      action: { _tag: "CancelSetup", topicId, operationId: terminalOperationId },
      available: true,
    });
    const details = renderDashboardView(
      { ...view, sidebarOpen: true, focus: "actions" },
      active,
      120,
      30,
    ).join("\n");
    expect(details).toContain("Setup operation: running · setup 1/2");
  });

  test("requests one direct Cancel Setup confirmation and rejection keeps Setup active", async () => {
    const fake = new FakeRuntime();
    const current = snapshot();
    const active: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        operations: [
          {
            id: terminalOperationId,
            topicId,
            state: "running",
            phase: "setup 1/2",
            input: { version: 1, kind: "topic.provision", value: {} },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
            rowRevision: 1,
          },
        ],
      },
    };
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: active });
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("\r");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(fake.cancellationRequests).toEqual([terminalOperationId]);
    expect(component.render(120).join("\n")).toContain(
      "Cancel Setup? Completed checkpoints and external artifacts remain.",
    );
    component.handleInput("n");
    await Bun.sleep(0);
    expect(fake.rejects).toEqual([]);
    expect(component.snapshotViewState().message).toBe(
      "Setup cancellation rejected. Provisioning continues.",
    );
    expect(component.render(120).join("\n")).toContain("Cancel Setup");

    component.handleInput("\r");
    await Bun.sleep(0);
    component.handleInput("y");
    component.handleInput("y");
    await Bun.sleep(0);
    expect(fake.cancellationRequests).toEqual([terminalOperationId, terminalOperationId]);
    expect(fake.confirms).toEqual([`${terminalOperationId}:cancel-secret`]);
    expect(component.snapshotViewState().message).toBe(
      "Setup cancelled. Completed checkpoints and external artifacts remain.",
    );
    expect(component.render(120).join("\n")).toContain("Setup operation: cancelled · cancelled");
    await component.dispose();
  });

  test("fills the available terminal height", () => {
    const lines = renderDashboardView(initialDashboardViewState(), snapshot(), 120, 30);

    expect(lines).toHaveLength(30);
  });

  test("keeps the helper row at the bottom of the screen", () => {
    const lines = renderDashboardView(initialDashboardViewState(), snapshot(), 120, 30);

    expect(lines.at(-1)).toContain("j/k select");
  });

  test("opens a full-height sidebar and moves through all three focus positions", () => {
    const state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const detail = handleDashboardViewInput(state, snapshot(), "l").state;
    const actions = handleDashboardViewInput(detail, snapshot(), "\x1b[C").state;
    const backToDetail = handleDashboardViewInput(actions, snapshot(), "h").state;
    const list = handleDashboardViewInput(backToDetail, snapshot(), "\x1b[D").state;
    const lines = renderDashboardView(actions, snapshot(), 120, 30);

    expect([detail.focus, actions.focus, backToDetail.focus, list.focus]).toEqual([
      "detail",
      "actions",
      "detail",
      "list",
    ]);
    expect(list.sidebarOpen).toBeTrue();
    expect(lines.every((line) => line.includes("│"))).toBeTrue();
    expect(lines.join("\n")).toContain("> Copy Branch Name");
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

  test("highlights saved Notes that contain the exact LAUNCHPAD word", () => {
    const current = snapshot();
    const withNote = (note: string): WorkSnapshot => ({
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((entry) =>
          entry.topic.id === topicId ? { ...entry, topic: { ...entry.topic, note } } : entry,
        ),
      },
    });
    const launchpad = withNote("Ready for LAUNCHPAD review");
    const state = reconcileDashboardSelection(initialDashboardViewState(), launchpad);
    const list = renderDashboardView(state, launchpad, 160, 30).join("\n");

    expect(list).toContain(
      "\x1b[22m\x1b[48;2;235;203;139m\x1b[38;2;46;52;64m\x1b[1mReady for LAUNCHPAD review",
    );
    expect(list).toContain("\x1b[22m\x1b[39m\x1b[49m\x1b[48;2;59;66;82m");

    const details = renderDashboardView(
      { ...state, sidebarOpen: true, focus: "detail" },
      launchpad,
      120,
      30,
    ).join("\n");
    expect(details).toContain(
      "Note: \x1b[22m\x1b[48;2;235;203;139m\x1b[38;2;46;52;64m\x1b[1mReady for LAUNCHPAD review",
    );

    for (const note of ["launchpad", "LAUNCHPADS", "MYLAUNCHPAD"]) {
      expect(renderDashboardView(state, withNote(note), 160, 30).join("\n")).not.toContain(
        "\x1b[48;2;235;203;139m",
      );
    }
  });

  test("leaves settled and absent Topic status cells empty", () => {
    const row = renderDashboardView(initialDashboardViewState(), snapshot(), 120, 30).find((line) =>
      line.includes("Checkpoint"),
    );

    expect(row).not.toContain("stopped");
    expect(row).not.toContain("—");
    expect(row).not.toContain("ready");
  });

  test("uses the previous subtle background for the selected Topic row", () => {
    const state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const row = renderDashboardView(state, snapshot(), 120, 30).find((line) =>
      line.includes("Alpha"),
    );

    expect(row).toStartWith("\x1b[48;2;59;66;82m");
    expect(row).toEndWith("\x1b[49m");
  });

  test("keeps inactive selected text dim under the Nord row background", () => {
    const state = {
      ...reconcileDashboardSelection(initialDashboardViewState(), snapshot()),
      selectedTopicId: childId,
    };
    const row = renderDashboardView(state, snapshot(), 120, 30).find((line) =>
      line.includes("Checkpoint"),
    );

    expect(row).toStartWith("\x1b[48;2;59;66;82m\x1b[2m");
    expect(stripSgr(row ?? "")).not.toContain("stopped");
  });

  test("validates, saves, and cancels Rename and Note editor values", () => {
    let state = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    state = handleDashboardViewInput(state, snapshot(), "n").state;
    state = updateDashboardEditorValue(state, "  Ready\nfor review  ");
    const note = handleDashboardViewInput(state, snapshot(), "\r");
    expect(note.action).toEqual({ _tag: "SetNote", topicId, note: "Ready for review" });

    const maximumNote = handleDashboardViewInput(
      { ...note.state, editor: { kind: "note", topicId, value: "x".repeat(200) } },
      snapshot(),
      "\r",
    );
    expect(maximumNote.action).toEqual({ _tag: "SetNote", topicId, note: "x".repeat(200) });

    state = { ...note.state, editor: { kind: "note", topicId, value: "x".repeat(201) } };
    const oversizedNote = handleDashboardViewInput(state, snapshot(), "\r");
    expect(oversizedNote.action).toBeUndefined();
    expect(oversizedNote.state.editor).toMatchObject({
      kind: "note",
      error: "Topic Note must not exceed 200 characters.",
    });

    state = updateDashboardEditorValue(oversizedNote.state, "   ");
    const removed = handleDashboardViewInput(state, snapshot(), "\r");
    expect(removed.action).toEqual({ _tag: "SetNote", topicId, note: "" });

    state = { ...removed.state, editor: { kind: "rename", topicId, value: "   " } };
    const emptyRename = handleDashboardViewInput(state, snapshot(), "\r");
    expect(emptyRename.state.editor).toMatchObject({
      kind: "rename",
      error: "Topic name must not be empty.",
    });
    state = updateDashboardEditorValue(emptyRename.state, "x".repeat(200));
    const maximumRename = handleDashboardViewInput(state, snapshot(), "\r");
    expect(maximumRename.action).toEqual({ _tag: "Rename", topicId, name: "x".repeat(200) });
    state = {
      ...maximumRename.state,
      editor: { kind: "rename", topicId, value: "x".repeat(201) },
    };
    const oversizedRename = handleDashboardViewInput(state, snapshot(), "\r");
    expect(oversizedRename.state.editor).toMatchObject({
      kind: "rename",
      error: "Topic name must not exceed 200 characters.",
    });

    const cancelled = handleDashboardViewInput(oversizedRename.state, snapshot(), "\x1b");
    expect(cancelled.action).toBeUndefined();
    expect(cancelled.state.editor).toBeUndefined();

    const rebase = handleDashboardViewInput(
      { ...cancelled.state, focus: "list", sidebarOpen: false },
      snapshot(),
      "s",
    );
    expect(rebase.action).toBeUndefined();
    expect(rebase.state.message).toContain("Main Agent is thinking");
  });

  test("opens a terminal with t only for a ready Topic while the list has focus", () => {
    const current = snapshot();
    let state = reconcileDashboardSelection(initialDashboardViewState(), current);
    expect(handleDashboardViewInput(state, current, "t").action).toEqual({
      _tag: "OpenTerminal",
      topicId,
    });

    state = handleDashboardViewInput(state, current, "l").state;
    expect(handleDashboardViewInput(state, current, "t").action).toBeUndefined();

    const unavailable: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((row) =>
          row.topic.id === topicId
            ? {
                ...row,
                topic: {
                  ...row.topic,
                  worktreePath: null,
                  setup: { ...row.topic.setup, state: "setup-failed" },
                },
              }
            : row,
        ),
      },
    };
    const unavailableState = reconcileDashboardSelection(initialDashboardViewState(), unavailable);
    expect(handleDashboardViewInput(unavailableState, unavailable, "t").action).toBeUndefined();
  });

  test("opens the Main Agent with m only from Topic-list focus and when available", () => {
    const current = snapshot();
    let state = reconcileDashboardSelection(initialDashboardViewState(), current);
    expect(handleDashboardViewInput(state, current, "m").action).toEqual({
      _tag: "OpenMainAgent",
      topicId,
    });

    state = handleDashboardViewInput(state, current, "l").state;
    expect(handleDashboardViewInput(state, current, "m").action).toBeUndefined();

    const denied: WorkSnapshot = {
      ...current,
      observed: {
        ...current.observed,
        policies: [{ action: "agent.open", decision: "deny", scope: { kind: "topic", topicId } }],
      },
    };
    state = reconcileDashboardSelection(initialDashboardViewState(), denied);
    expect(handleDashboardViewInput(state, denied, "m").action).toBeUndefined();
  });

  test("projects denial into the terminal action rail without attempting the action", () => {
    const current = snapshot();
    const denied: WorkSnapshot = {
      ...current,
      observed: {
        ...current.observed,
        policies: [
          {
            action: "terminal.open",
            decision: "deny",
            scope: { kind: "topic", topicId },
          },
        ],
      },
    };
    let state = reconcileDashboardSelection(initialDashboardViewState(), denied);
    expect(handleDashboardViewInput(state, denied, "t").action).toBeUndefined();
    state = handleDashboardViewInput(state, denied, "l").state;
    expect(renderDashboardView(state, denied, 200, 30).join("\n")).toContain(
      "Denied by Action policy",
    );
  });

  test("shows exact Main Agent policy reasons in the action rail", () => {
    const current = snapshot();
    const denied: WorkSnapshot = {
      ...current,
      observed: {
        ...current.observed,
        policies: [
          { action: "agent.open", decision: "deny", scope: { kind: "topic", topicId } },
          { action: "agent.reset", decision: "deny", scope: { kind: "topic", topicId } },
        ],
      },
    };
    const state = handleDashboardViewInput(
      reconcileDashboardSelection(initialDashboardViewState(), denied),
      denied,
      "l",
    ).state;
    expect(
      topicActions(state, denied).filter(
        (item) => item.action._tag === "OpenMainAgent" || item.action._tag === "ResetMainAgent",
      ),
    ).toEqual([
      {
        label: "Open Main Agent",
        action: { _tag: "OpenMainAgent", topicId },
        available: false,
        reason: "Denied by Action policy",
      },
      {
        label: "Start New Main Agent",
        action: { _tag: "ResetMainAgent", topicId },
        available: false,
        reason: "Denied by Action policy",
      },
    ]);
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
    expect(screen).toContain("Access Topic Workspace");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.actions).toContainEqual({ action: "workspace", topicId });

    component.handleInput("h");
    component.handleInput("h");
    component.handleInput("t");
    await Bun.sleep(0);
    expect(fake.starts).toContainEqual({
      fingerprint: `terminal.open:${topicId}`,
      topicId,
      input: { version: 1, kind: "terminal.open", value: {} },
      phase: "authorizing",
    });
    await component.dispose();
  });

  test("keeps the action rail stable and gives delayed inline copy feedback", async () => {
    const fake = new FakeRuntime();
    let finishCopy: (() => void) | undefined;
    const copy = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      copyToClipboard: () => copy,
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("l");
    component.handleInput("l");
    const before = component.render(120);

    component.handleInput("\r");
    expect(component.render(120)).toEqual(before);

    expect(fake.scheduleIntervals.at(-1)).toBe(120);
    fake.schedules.at(-1)!();
    const working = component.render(120);
    expect(working).toHaveLength(before.length);
    expect(stripSgr(working.join("\n"))).toContain("Copy Branch Name · Working…");
    expect(stripSgr(working.join("\n"))).not.toContain("Submission: in progress");
    expect(stripSgr(working.join("\n"))).not.toContain("A Topic action is already in progress");
    expect(working.find((line) => line.includes("Access Topic Workspace"))).toBe(
      before.find((line) => line.includes("Access Topic Workspace")),
    );

    finishCopy!();
    await Bun.sleep(0);
    const copied = component.render(120).join("\n");
    expect(stripSgr(copied)).toContain("Copy Branch Name · Copied");
    expect(copied).toContain("\x1b[32mCopied\x1b[39m");
    expect(component.snapshotViewState().message).toBeUndefined();

    component.handleInput("j");
    const movedFocus = stripSgr(component.render(120).join("\n"));
    expect(movedFocus).toContain("  Copy Branch Name · Copied");
    expect(movedFocus).toContain("> Access Topic Workspace");

    expect(fake.scheduleIntervals.at(-1)).toBe(500);
    fake.schedules.at(-1)!();
    expect(stripSgr(component.render(120).join("\n"))).not.toContain(" · Copied");
    await component.dispose();
  });

  test("keeps failed action feedback until Topic selection changes", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      copyToClipboard: async () => {
        throw new Error("Clipboard unavailable.");
      },
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("\r");
    await Bun.sleep(0);

    const failed = component.render(120).join("\n");
    expect(stripSgr(failed)).toContain("Copy Branch Name · Failed");
    expect(failed).toContain("\x1b[31mFailed\x1b[39m");
    expect(component.snapshotViewState().message).toBe("Clipboard unavailable.");

    component.handleInput("h");
    component.handleInput("h");
    component.handleInput("j");
    expect(component.snapshotViewState().selectedTopicId).toBe(childId);
    expect(component.snapshotViewState().actionFeedback).toBeUndefined();
    await component.dispose();
  });

  test("stops action feedback after dashboard disposal", async () => {
    const fake = new FakeRuntime();
    let renderRequests = 0;
    let finishCopy: (() => void) | undefined;
    const copy = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const component = new EffectWorkDashboardComponent({
      tui: {
        requestRender() {
          renderRequests += 1;
        },
        terminal: { rows: 30 },
      } as never,
      client: fake.runtime,
      done() {},
      copyToClipboard: () => copy,
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("\r");
    const requestsAtDisposal = renderRequests;

    await component.dispose();
    fake.schedules.at(-1)!();
    finishCopy!();
    await Bun.sleep(0);
    expect(renderRequests).toBe(requestsAtDisposal);
    expect(component.snapshotViewState().actionFeedback).toBeUndefined();
  });

  test("opens the pull request from p and reports local refresh before background updates", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    const base = snapshot();
    const current: WorkSnapshot = {
      ...base,
      durable: {
        ...base.durable,
        topics: base.durable.topics.map((row) =>
          row.topic.id === topicId
            ? { ...row, topic: { ...row.topic, pullRequest: { number: 42 } } }
            : row,
        ),
      },
    };
    fake.stateHandler!({ _tag: "Snapshot", snapshot: current });
    component.handleInput("p");
    await Bun.sleep(0);
    expect(fake.actions).toContainEqual({ action: "pull-request", topicId });

    component.handleInput("r");
    await Bun.sleep(0);
    expect(fake.actions.slice(-3)).toEqual([
      { action: "refresh-local" },
      { action: "refresh-integration" },
      { action: "refresh-pull-requests" },
    ]);
    expect(component.render(160).join("\n")).toContain(
      "Local repository state refreshed; pull requests are updating.",
    );
    await component.dispose();
  });

  test("uses the same operation path from the rail and records direct rejection", async () => {
    const fake = new FakeRuntime();
    fake.askFor = "terminal.open";
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(component.render(120).join("\n")).toContain("Open a terminal for this Topic?");
    component.handleInput("n");
    await Bun.sleep(0);
    expect(fake.rejects).toEqual([terminalOperationId]);
    expect(component.snapshotViewState().message).toBe("Terminal opening rejected.");
    await component.dispose();
  });

  test("uses policy confirmation for reset and does not invoke the legacy Main Agent RPC", async () => {
    const fake = new FakeRuntime();
    fake.askFor = "agent.reset";
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("\r");
    for (let step = 0; step < 4; step += 1) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.starts).toContainEqual({
      fingerprint: `agent.reset:${topicId}`,
      topicId,
      input: { version: 1, kind: "agent.reset", value: {} },
      phase: "authorizing",
    });
    expect(component.render(120).join("\n")).toContain(
      "Start a new empty Main Agent for this Topic?",
    );
    component.handleInput("y");
    await Bun.sleep(0);
    expect(fake.confirms).toEqual([`${terminalOperationId}:direct-secret`]);
    expect(stripSgr(component.render(120).join("\n"))).toContain("Start New Main Agent · Started");
    expect(component.snapshotViewState().message).toBeUndefined();
    await component.dispose();
  });

  test("uses standard focused text entry for Rename and Note from open through save", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    component.focused = true;
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });

    component.handleInput("\r");
    for (let step = 0; step < 6; step += 1) component.handleInput("j");
    component.handleInput("\r");
    expect(component.snapshotViewState().editor?.kind).toBe("rename");
    expect(component.render(120).join("\n")).toContain(CURSOR_MARKER);

    component.handleInput("\x15");
    component.handleInput("\x1b[200~Omea\x1b[201~");
    component.handleInput("\x1b[D");
    component.handleInput("g");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toContainEqual({ _tag: "Rename", topicId, name: "Omega" });
    expect(component.snapshotViewState().editor).toBeUndefined();
    expect(component.render(120).join("\n")).not.toContain(CURSOR_MARKER);

    component.handleInput("q");
    component.handleInput("n");
    component.handleInput("\x1b[200~waiting\r\nfor Tom\x1b[201~");
    expect(component.snapshotViewState().editor?.value).toBe("waiting for Tom");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toContainEqual({
      _tag: "SetNote",
      topicId,
      note: "waiting for Tom",
    });
    await component.dispose();
  });

  test("keeps invalid text focused, cancels without mutation, and releases focus on disposal", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    component.focused = true;
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });

    component.handleInput("n");
    component.handleInput("x".repeat(201));
    component.handleInput("\r");
    expect(component.snapshotViewState().editor).toMatchObject({
      error: "Topic Note must not exceed 200 characters.",
    });
    expect(component.render(120).join("\n")).toContain(CURSOR_MARKER);
    expect(fake.commands).toHaveLength(0);

    component.handleInput("\x1b");
    expect(fake.commands).toHaveLength(0);
    component.handleInput("n");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(fake.commands).toContainEqual({ _tag: "SetNote", topicId, note: "" });

    component.handleInput("n");
    expect(component.render(120).join("\n")).toContain(CURSOR_MARKER);
    await component.dispose();
    expect(component.render(120).join("\n")).not.toContain(CURSOR_MARKER);
  });

  test("shows the manifest-only delete warning and selects the nearest Topic after approval", async () => {
    const fake = new FakeRuntime();
    fake.askFor = "topic.delete";
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    component.handleInput("j");
    component.handleInput("\r");
    const deleteIndex = topicActions(component.snapshotViewState(), snapshot()).findIndex(
      (item) => item.action._tag === "Delete",
    );
    while (component.snapshotViewState().focusedAction !== deleteIndex) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(fake.starts).toContainEqual({
      fingerprint: `topic.delete:${childId}`,
      topicId: childId,
      input: { version: 1, kind: "topic.delete", value: {} },
      phase: "authorizing",
    });
    expect(component.render(120).join("\n")).toContain(
      "Delete Topic Checkpoint? The Branch and Worktree are not deleted.",
    );

    component.handleInput("y");
    await Bun.sleep(0);
    expect(component.snapshotViewState().selectedTopicId).toBe(topicId);
    expect(component.snapshotViewState().message).toBe("Topic deleted.");
    await component.dispose();
  });

  test("starts one stable retry and uses direct confirmation for ask", async () => {
    const current = snapshot();
    const failed: WorkSnapshot = {
      ...current,
      durable: {
        ...current.durable,
        topics: current.durable.topics.map((row) =>
          row.topic.id === topicId
            ? {
                ...row,
                topic: {
                  ...row.topic,
                  setup: {
                    ...row.topic.setup,
                    state: "setup-failed",
                    setupCommandsRun: false,
                    reason: "A Setup command failed.",
                  },
                },
              }
            : row,
        ),
      },
    };
    const fake = new FakeRuntime();
    fake.askFor = "topic.provision";
    const configuration: WorkConfiguration = {
      ...dashboardConfiguration,
      policies: {
        ...dashboardConfiguration.policies,
        defaults: {
          ...dashboardConfiguration.policies.defaults,
          "topic.run-setup": "ask",
        },
      },
      repositories: {
        ...dashboardConfiguration.repositories,
        [Repository.make("owner/repo")]: { setupCommands: ["first", "second"] },
      },
    };
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      configuration,
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: failed });
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("\r");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(fake.starts).toHaveLength(1);
    const request = fake.starts[0] as {
      requestId: string;
      fingerprint: string;
      input: {
        value: { attempt: string; topic: { id: TopicId; branch: string; partition: number } };
      };
    };
    expect(request.requestId).toBeString();
    expect(request.fingerprint).toBeString();
    expect(request.input.value).toMatchObject({
      attempt: "retry",
      topic: { id: topicId, branch: "alpha", partition: 0 },
    });
    expect(component.render(120).join("\n")).toContain(
      "Run the Repository Recipe again from command one?",
    );
    component.handleInput("y");
    await Bun.sleep(0);
    expect(fake.confirms).toEqual([`${terminalOperationId}:direct-secret`]);
    expect(component.snapshotViewState().message).toBe("Setup retry completed.");
    await component.dispose();
  });
  test("starts one root Topic from the exact reviewed identity and ignores repeated submit", async () => {
    const fake = new FakeRuntime();
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      configuration: dashboardConfiguration,
    });
    component.focused = true;
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });

    component.handleInput("A");
    component.handleInput("\x1b[200~New Topic\x1b[201~");
    component.handleInput("\r");
    component.handleInput("ledger");
    component.handleInput("\x1b[B");
    component.handleInput("\t");
    expect(component.snapshotRootWizard()?.repository).toBe("LedgerHQ/ledger-live");
    component.handleInput("\r");
    component.handleInput("\x15");
    component.handleInput("new-topic-edited");
    component.handleInput("\r");
    expect(component.render(120).join("\n")).toContain("Branch: new-topic-edited");
    component.handleInput("\r");
    component.handleInput("\r");
    await Bun.sleep(10);

    expect(fake.starts).toHaveLength(1);
    const request = fake.starts[0] as {
      input: {
        kind: string;
        value: { topic: { name: string; repository: string; branch: string } };
      };
      requestId: string;
      fingerprint: string;
    };
    expect(request.input.kind).toBe("topic.provision");
    expect(request.input.value.topic).toMatchObject({
      name: "New Topic",
      repository: "LedgerHQ/ledger-live",
      branch: "new-topic-edited",
    });
    expect(request.requestId).toBeString();
    expect(request.fingerprint).toBeString();
    expect(component.snapshotRootWizard()).toBeUndefined();
    expect(component.snapshotViewState().message).toBe("Topic provisioning started.");
    await component.dispose();
  });

  test("handles direct provisioning confirmation and Escape rejects it", async () => {
    const fake = new FakeRuntime();
    fake.askFor = "topic.provision";
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      configuration: dashboardConfiguration,
    });
    component.handleInput("a");
    for (const input of ["Confirm me", "\r", "owner/repo", "\r", "\r", "\r"]) {
      component.handleInput(input);
    }
    await Bun.sleep(10);
    expect(component.snapshotRootWizard()?.stage).toBe("confirmation");
    expect(component.render(120).join("\n")).toContain("needs confirmation");
    component.handleInput("\x1b");
    await Bun.sleep(0);
    expect(fake.rejects).toEqual([terminalOperationId]);
    expect(component.snapshotRootWizard()).toBeUndefined();
    expect(fake.starts).toHaveLength(1);
    await component.dispose();
  });

  test("returns to the Topic list as soon as confirmed provisioning is accepted", async () => {
    const fake = new FakeRuntime();
    fake.askFor = "topic.provision";
    fake.awaitOperationPending = true;
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
      configuration: dashboardConfiguration,
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });

    component.handleInput("a");
    for (const input of ["Pending Topic", "\r", "owner/repo", "\r", "\r", "\r"]) {
      component.handleInput(input);
    }
    await Bun.sleep(0);
    expect(component.snapshotRootWizard()?.stage).toBe("confirmation");

    component.handleInput("\r");
    await Bun.sleep(0);

    expect(component.snapshotRootWizard()).toBeUndefined();
    expect(fake.awaitOperationCalls).toBe(0);
    expect(component.snapshotViewState().message).toBe("Topic provisioning started.");

    const current = snapshot();
    const created = (
      fake.starts[0] as {
        input: { value: { topic: WorkSnapshot["durable"]["topics"][number]["topic"] } };
      }
    ).input.value.topic;
    fake.stateHandler!({
      _tag: "Snapshot",
      snapshot: {
        ...current,
        durable: {
          ...current.durable,
          topics: [...current.durable.topics, { rowRevision: 0, topic: created }],
        },
      },
    });
    expect(component.snapshotViewState().selectedTopicId).toBe(created.id);
    expect(stripSgr(component.render(120).join("\n"))).toContain("provisioning");
    await component.dispose();
  });

  test("creates and selects one pending child through the Parent Topic action", async () => {
    const root = await createTemporaryRoot("pi-work-dashboard-child-");
    try {
      const scenario = await createParentBranchScenario(root, { checkpointCount: 2 });
      await scenario.repository.git("remote", "add", "origin", "git@github.com:owner/repo.git");
      await scenario.repository.checkout(scenario.parentBranch);
      const current = snapshot();
      const local: WorkSnapshot = {
        ...current,
        durable: {
          ...current.durable,
          topics: current.durable.topics.map((row) =>
            row.topic.id === topicId
              ? {
                  ...row,
                  topic: {
                    ...row.topic,
                    branch: Branch.make(scenario.parentBranch),
                    worktreePath: AbsolutePath.make(scenario.repository.path),
                  },
                }
              : row,
          ),
        },
      };
      const fake = new FakeRuntime();
      const component = new EffectWorkDashboardComponent({
        tui: { requestRender() {}, terminal: { rows: 30 } } as never,
        client: fake.runtime,
        done() {},
        configuration: dashboardConfiguration,
      });
      component.focused = true;
      fake.stateHandler!({ _tag: "Snapshot", snapshot: local });
      component.handleInput("\r");
      const addChildIndex = topicActions(component.snapshotViewState(), local).findIndex(
        (action) => action.action._tag === "AddChild",
      );
      expect(addChildIndex).toBeGreaterThanOrEqual(0);
      for (
        let step = 0;
        step < 12 && component.snapshotViewState().focusedAction !== addChildIndex;
        step += 1
      ) {
        component.handleInput("j");
      }
      expect(component.snapshotViewState().focusedAction).toBe(addChildIndex);
      component.handleInput("\r");
      expect(component.snapshotChildWizard()).toMatchObject({
        stage: "name",
        parentTopicId: topicId,
        parentName: "Alpha",
      });
      component.handleInput("\x1b[200~Child Checkpoint\x1b[201~");
      component.handleInput("\r");
      component.handleInput(`\x1b[200~${scenario.checkpoints[0]!}\x1b[201~`);
      component.handleInput("\r");
      component.handleInput("\r");
      component.handleInput("\r");
      component.handleInput("\r");
      await Bun.sleep(150);

      expect(fake.starts).toHaveLength(1);
      const request = fake.starts[0] as { input: { value: { topic: Record<string, unknown> } } };
      expect(request.input.value.topic).toMatchObject({
        name: "Child Checkpoint",
        branch: "child-checkpoint",
        parentTopicId: topicId,
        partition: 0,
        originCommit: scenario.checkpoints[0],
        chainState: "pending",
      });
      expect(component.snapshotChildWizard()).toBeUndefined();
      expect(component.snapshotViewState().selectedTopicId).toBe(
        request.input.value.topic["id"] as TopicId,
      );
      expect(component.snapshotViewState().message).toBe("Child Topic created.");
      await component.dispose();
    } finally {
      await removeTemporaryRoots([root]);
    }
  });

  test("closes details with q or Q and exits safely with Escape or Ctrl-C", () => {
    const selected = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const detail = handleDashboardViewInput(selected, snapshot(), "l").state;

    for (const key of ["q", "Q"]) {
      const closed = handleDashboardViewInput(detail, snapshot(), key);
      expect(closed.exit).toBeUndefined();
      expect(closed.state).toMatchObject({ sidebarOpen: false, focus: "list" });
    }
    expect(handleDashboardViewInput(selected, snapshot(), "q").exit).toBeUndefined();
    expect(handleDashboardViewInput(detail, snapshot(), "\x1b").exit).toBeTrue();
    expect(handleDashboardViewInput(detail, snapshot(), "\x03").exit).toBeTrue();
  });

  test("blocks direct Topic shortcuts outside list focus and while that Topic is busy", () => {
    const selected = reconcileDashboardSelection(initialDashboardViewState(), snapshot());
    const busy = { ...selected, pending: new Set<string>([topicId]) };
    for (const key of ["m", "o", "t", "s", "n", "J", "K"]) {
      const result = handleDashboardViewInput(busy, snapshot(), key);
      expect(result.action).toBeUndefined();
      expect(result.state.editor).toBeUndefined();
    }

    const detail = handleDashboardViewInput(selected, snapshot(), "l").state;
    for (const key of ["m", "o", "t", "s", "n", "J", "K"]) {
      expect(handleDashboardViewInput(detail, snapshot(), key).action).toBeUndefined();
    }
  });

  test("focuses unavailable actions, explains them, and clamps at rail boundaries", () => {
    const current = snapshot();
    const denied: WorkSnapshot = {
      ...current,
      observed: {
        ...current.observed,
        policies: [
          { action: "terminal.open", decision: "deny", scope: { kind: "topic", topicId } },
        ],
      },
    };
    let state = handleDashboardViewInput(
      reconcileDashboardSelection(initialDashboardViewState(), denied),
      denied,
      "\r",
    ).state;
    const actions = topicActions(state, denied);
    const terminal = actions.findIndex((item) => item.action._tag === "OpenTerminal");
    state = { ...state, focusedAction: terminal };
    const unavailable = handleDashboardViewInput(state, denied, "\r");
    expect(unavailable.action).toBeUndefined();
    expect(unavailable.state.message).toBe("Denied by Action policy");

    const first = handleDashboardViewInput({ ...state, focusedAction: 0 }, denied, "k").state;
    const lastIndex = actions.length - 1;
    const last = handleDashboardViewInput(
      { ...state, focusedAction: lastIndex },
      denied,
      "j",
    ).state;
    expect(first.focusedAction).toBe(0);
    expect(last.focusedAction).toBe(lastIndex);
  });

  test("keeps large-list selection visible and accounts for Partition rows", () => {
    const base = snapshot();
    const template = base.durable.topics[0]!.topic;
    const topics = Array.from({ length: 40 }, (_, index) => ({
      rowRevision: 0,
      topic: {
        ...template,
        id: TopicId.make(`30000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`),
        name: `Topic ${index.toString().padStart(2, "0")}`,
        branch: Branch.make(`topic-${index}`),
        partition: Math.floor(index / 4),
      },
    }));
    const large: WorkSnapshot = {
      ...base,
      durable: { ...base.durable, topics },
      observed: { ...base.observed, topics: [] },
    };
    const selectedTopicId = topics[32]!.topic.id;
    const state = reconcileDashboardSelection(
      { ...initialDashboardViewState(), selectedTopicId },
      large,
    );
    const lines = renderDashboardView(state, large, 120, 12);
    expect(lines).toHaveLength(12);
    expect(lines.some((line) => line.includes("Topic 32"))).toBeTrue();
    expect(lines.at(-1)).toContain("j/k select");
  });

  test("preserves selection by ID and uses its nearest row after removal", () => {
    const base = snapshot();
    const template = base.durable.topics[0]!.topic;
    const ids = [0, 1, 2].map((index) =>
      TopicId.make(`40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`),
    );
    const makeSnapshot = (names: readonly string[], omitted?: TopicId): WorkSnapshot => ({
      ...base,
      durable: {
        ...base.durable,
        topics: names.flatMap((name, index) =>
          ids[index] === omitted
            ? []
            : [
                {
                  rowRevision: 0,
                  topic: {
                    ...template,
                    id: ids[index]!,
                    name,
                    branch: Branch.make(`selection-${index}`),
                  },
                },
              ],
        ),
      },
      observed: { ...base.observed, topics: [] },
    });
    let state = reconcileDashboardSelection(
      { ...initialDashboardViewState(), selectedTopicId: ids[1]! },
      makeSnapshot(["Alpha", "Beta", "Gamma"]),
    );
    state = reconcileDashboardSelection(state, makeSnapshot(["Zulu", "Beta", "Gamma"]));
    expect(state.selectedTopicId).toBe(ids[1]);
    expect(state.selectionIndex).toBe(0);

    state = reconcileDashboardSelection(state, makeSnapshot(["Zulu", "Beta", "Gamma"], ids[1]));
    expect(state.selectedTopicId).toBe(ids[2]);
  });

  test("uses the previous narrow and wide sidebar thresholds and split", () => {
    expect(calculateDashboardLayout(95, true)).toEqual({
      wide: false,
      listWidth: 95,
      sidebarWidth: 95,
    });
    expect(calculateDashboardLayout(120, true)).toEqual({
      wide: true,
      listWidth: 79,
      sidebarWidth: 40,
    });
  });

  test("reports workspace pool exhaustion as information and permits a safe retry", async () => {
    const fake = new FakeRuntime();
    fake.ephemeralResult = {
      kind: "unavailable",
      message: "No empty workspace is available in the temporary pool (1-10).",
    };
    const component = new EffectWorkDashboardComponent({
      tui: { requestRender() {}, terminal: { rows: 30 } } as never,
      client: fake.runtime,
      done() {},
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });

    component.handleInput("o");
    await Bun.sleep(0);
    expect(component.snapshotViewState().message).toContain("No empty workspace");
    component.handleInput("o");
    await Bun.sleep(0);
    expect(fake.actions.filter((item) => item.action === "workspace")).toHaveLength(2);
    await component.dispose();
  });
});
