import { describe, expect, test } from "bun:test";
import {
  Branch,
  ClientId,
  FullCommitSha,
  OperationId,
  Repository,
  RequestId,
  TopicId,
  type DurableOperationResult,
} from "../domain/index.ts";
import type { WorkSnapshot, WorkStreamItem } from "../application/state/index.ts";
import type { DurableOperation } from "../infrastructure/rpc/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import {
  EffectDashboardRuntime,
  initialEffectDashboardState,
  integrationBranchLabel,
  interruptedSetupLabel,
  observationFreshnessLabel,
  reduceEffectDashboardState,
} from "./dashboard-runtime.ts";

const topicId = TopicId.make("10000000-0000-4000-8000-000000000001");
const operationId = OperationId.make("20000000-0000-4000-8000-000000000001");
const repository = Repository.make("owner/repository");
const branch = Branch.make("feature");

function snapshot(revision = 0): WorkSnapshot {
  return {
    daemon: { id: "daemon-1", startedAt: "2026-01-01T00:00:00.000Z" },
    revision,
    durable: {
      topics: [
        {
          rowRevision: 0,
          topic: {
            id: topicId,
            name: "Effect dashboard",
            branch,
            repository,
            setup: {
              state: "setup-interrupted",
              repositoryAvailable: true,
              worktreeCreated: true,
              setupCommandsRun: false,
              completedCommandCount: 1,
              reason: "The Setup command was interrupted.",
            },
            worktreePath: null,
            mainAgent: { sessionId: "session", sessionFile: null },
            partition: 0,
            originCommit: FullCommitSha.make("a".repeat(40)),
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:01:00.000Z",
          },
        },
      ],
      repositoryStates: [
        {
          repository,
          inferredIntegrationBranch: Branch.make("main"),
          rowRevision: 0,
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      operations: [
        {
          id: operationId,
          topicId,
          state: "running",
          phase: "setup",
          input: { version: 1, kind: "provision", value: {} },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
          rowRevision: 0,
        },
      ],
    },
    observed: {
      topics: [
        {
          topicId,
          freshness: { _tag: "Fresh", observedAt: "2026-01-01T00:00:02.000Z" },
          value: {
            topicId,
            integrationStatus: "current",
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

function operation(state: DurableOperation["state"] = "running"): DurableOperation {
  return {
    id: operationId,
    clientId: ClientId.make("30000000-0000-4000-8000-000000000001"),
    requestId: RequestId.make("40000000-0000-4000-8000-000000000001"),
    topicId,
    state,
    phase: "setup",
    input: { version: 1, kind: "provision", value: {} },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    revision: 0,
  };
}

class FakeRuntime {
  stateHandler: ((item: WorkStreamItem) => void) | undefined;
  commandCalls: Array<{ command: unknown; requestId: RequestId | undefined }> = [];
  commandRuns: Array<() => void> = [];
  repeats: Array<() => void> = [];
  disposed = 0;
  watchStops = 0;
  repeatStops = 0;

  readonly runtime = {
    clientId: ClientId.make("50000000-0000-4000-8000-000000000001"),
    compatibility: async () => {
      throw new Error("not used");
    },
    snapshot: async () => snapshot(),
    startOperation: async () => {
      throw new Error("not used");
    },
    getOperation: async () => operation(),
    awaitOperation: async () => operation("succeeded"),
    startAndAwait: async () => operation("succeeded"),
    requestOperationCancellation: async () => ({ confirmation: "cancel-capability" }),
    confirmOperation: async () => operation("cancelled"),
    rejectOperation: async () => operation("running"),
    atomicCommand: (command: unknown, requestId?: RequestId) => {
      this.commandCalls.push({ command, requestId });
      return new Promise<DurableOperationResult>((resolve) => {
        this.commandRuns.push(() =>
          resolve({ version: 1, status: "succeeded", value: { command } }),
        );
      });
    },
    mainAgentCall: async () => undefined,
    ephemeralAction: async () => undefined,
    subscribeState: (handler: (item: WorkStreamItem) => void) => {
      this.stateHandler = handler;
      return () => undefined;
    },
    watchOperation: () => () => {
      this.watchStops += 1;
    },
    repeat: (_interval: number, task: () => void) => {
      this.repeats.push(task);
      return () => {
        this.repeatStops += 1;
      };
    },
    dispose: async () => {
      this.disposed += 1;
    },
  } as WorkClientRuntime;
}

describe("Effect dashboard pure state", () => {
  test("accepts snapshot-first changes and rejects revision gaps", () => {
    const connected = reduceEffectDashboardState(initialEffectDashboardState(), {
      _tag: "StreamItem",
      item: { _tag: "Snapshot", snapshot: snapshot() },
    });
    const change: WorkStreamItem = {
      _tag: "Change",
      daemonId: "daemon-1",
      revision: 1,
      change: { _tag: "ObservedChanged", diagnostics: [] },
    };
    expect(
      reduceEffectDashboardState(connected, { _tag: "StreamItem", item: change }).snapshot
        ?.revision,
    ).toBe(1);
    expect(
      reduceEffectDashboardState(connected, {
        _tag: "StreamItem",
        item: { ...change, revision: 2 },
      }).phase,
    ).toBe("reconnecting");
  });

  test("shows freshness, Interrupted Setup, and configured versus inferred Branches", () => {
    const value = snapshot();
    expect(observationFreshnessLabel(value.observed.topics[0]!.freshness)).toContain("Observed");
    expect(interruptedSetupLabel(value, topicId)).toBe("Interrupted Setup");
    expect(integrationBranchLabel(value, repository)).toBe("main (inferred)");
    expect(integrationBranchLabel(value, repository, Branch.make("trunk"))).toBe(
      "trunk (configured)",
    );
  });
});

describe("Effect dashboard scoped driver", () => {
  test("keeps Partition keypress order and stable request identities", async () => {
    const fake = new FakeRuntime();
    const driver = new EffectDashboardRuntime({ client: fake.runtime, onChange: () => undefined });
    const first = driver.movePartition(topicId, "down");
    const second = driver.movePartition(topicId, "up");
    await Promise.resolve();
    expect(fake.commandCalls).toHaveLength(1);
    const firstId = fake.commandCalls[0]!.requestId;
    fake.commandRuns.shift()!();
    await first;
    await Promise.resolve();
    expect(fake.commandCalls).toHaveLength(2);
    expect(fake.commandCalls[0]!.requestId).toBe(firstId);
    expect(fake.commandCalls[1]!.requestId).not.toBe(firstId);
    fake.commandRuns.shift()!();
    await second;
    await driver.dispose();
  });

  test("supervises shimmer, active watches, cancellation, reset, and disposal", async () => {
    const fake = new FakeRuntime();
    const states: string[] = [];
    const driver = new EffectDashboardRuntime({
      client: fake.runtime,
      onChange: (state) => states.push(`${state.phase}:${state.shimmerPhase}`),
    });
    fake.stateHandler!({ _tag: "Snapshot", snapshot: snapshot() });
    expect(fake.repeats).toHaveLength(1);
    fake.repeats[0]!();
    expect(driver.snapshotState().shimmerPhase).toBe(1);

    const cancellation = await driver.requestCancelSetup(operationId);
    expect(cancellation.text).toContain("Cancel active provisioning?");
    expect((await driver.confirmCancelSetup()).state).toBe("cancelled");

    const reset = driver.resetIntegrationBranch(repository);
    expect(fake.commandCalls.at(-1)?.command).toEqual({
      _tag: "ResetIntegrationBranch",
      repository,
    });
    fake.commandRuns.shift()!();
    await reset;

    await driver.dispose();
    await driver.dispose();
    expect(fake.disposed).toBe(1);
    expect(fake.repeatStops).toBe(1);
    expect(fake.watchStops).toBe(1);
    expect(states).toContain("connected:1");
  });
});
