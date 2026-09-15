import { randomUUID } from "node:crypto";
import {
  boundProjectedOperations,
  reduceWorkSnapshot,
  MAX_PROJECTED_OPERATIONS,
  type ObservationFreshness,
  type WorkSnapshot,
  type WorkStreamItem,
} from "../application/state/index.ts";
import {
  OperationId,
  RequestId,
  type Branch,
  type DurableOperationResult,
  type Repository,
  type TopicId,
} from "../domain/index.ts";
import type { DurableOperation, TopicCommand } from "../infrastructure/rpc/index.ts";
import { makeWorkClientRuntime, type WorkClientRuntime } from "./effect-runtime.ts";
import { isShimmeringMainAgentActivity, MAIN_AGENT_SHIMMER_PERIOD } from "./main-agent-display.ts";

export interface DashboardCancellation {
  readonly operationId: OperationId;
  readonly confirmation: string;
  readonly text: string;
}

/** State owned by the Effect dashboard driver. Rendering and input reduction consume this only. */
export interface EffectDashboardState {
  readonly phase: "loading" | "connected" | "reconnecting" | "failure";
  readonly snapshot?: WorkSnapshot;
  readonly operationUpdates: Readonly<Record<string, DurableOperation>>;
  readonly shimmerPhase: number;
  readonly cancellation?: DashboardCancellation;
  readonly message?: string;
}

export type DashboardRuntimeEvent =
  | { readonly _tag: "StreamItem"; readonly item: WorkStreamItem }
  | { readonly _tag: "StreamFailed"; readonly message: string }
  | { readonly _tag: "Shimmer" }
  | { readonly _tag: "OperationUpdated"; readonly operation: DurableOperation };

export function initialEffectDashboardState(): EffectDashboardState {
  return { phase: "loading", operationUpdates: {}, shimmerPhase: 0 };
}

/** Pure state-stream reduction. A bad daemon identity or revision waits for the next snapshot. */
export function reduceEffectDashboardState(
  state: EffectDashboardState,
  event: DashboardRuntimeEvent,
): EffectDashboardState {
  switch (event._tag) {
    case "StreamFailed":
      return { ...state, phase: "reconnecting", message: event.message };
    case "Shimmer":
      return {
        ...state,
        shimmerPhase: (state.shimmerPhase + 1) % MAIN_AGENT_SHIMMER_PERIOD,
      };
    case "OperationUpdated": {
      const operation = event.operation;
      const snapshot = state.snapshot;
      const operationUpdates = boundedOperationUpdates(state.operationUpdates, operation);
      return {
        ...state,
        operationUpdates,
        ...(snapshot === undefined
          ? {}
          : {
              snapshot: {
                ...snapshot,
                durable: {
                  ...snapshot.durable,
                  operations: boundProjectedOperations([
                    ...snapshot.durable.operations.filter((entry) => entry.id !== operation.id),
                    {
                      id: operation.id,
                      ...(operation.topicId === undefined ? {} : { topicId: operation.topicId }),
                      state: operation.state,
                      phase: operation.phase,
                      input: operation.input,
                      ...(operation.result === undefined ? {} : { result: operation.result }),
                      createdAt: operation.createdAt,
                      updatedAt: operation.updatedAt,
                      ...(operation.terminalAt === undefined
                        ? {}
                        : { terminalAt: operation.terminalAt }),
                      rowRevision: operation.revision,
                    },
                  ]),
                },
              },
            }),
      };
    }
    case "StreamItem": {
      const item = event.item;
      if (item._tag === "Snapshot") {
        const { message: _message, ...current } = state;
        return {
          ...current,
          phase: "connected",
          snapshot: item.snapshot,
          operationUpdates: {},
        };
      }
      if (item._tag === "ResyncRequired" || state.snapshot === undefined) {
        return { ...state, phase: "reconnecting", message: "Synchronizing Work state…" };
      }
      if (
        item.daemonId !== state.snapshot.daemon.id ||
        item.revision !== state.snapshot.revision + 1
      ) {
        return { ...state, phase: "reconnecting", message: "Synchronizing Work state…" };
      }
      const { message: _message, ...current } = state;
      return {
        ...current,
        phase: "connected",
        snapshot: reduceWorkSnapshot(state.snapshot, item.change, item.revision),
      };
    }
  }
}

export function observationFreshnessLabel(freshness: ObservationFreshness): string {
  switch (freshness._tag) {
    case "Unknown":
      return "Unknown";
    case "Refreshing":
      return `Refreshing since ${freshness.startedAt}`;
    case "Fresh":
      return `Observed ${freshness.observedAt}`;
    case "Failed":
      return `Observation failed ${freshness.failedAt}: ${freshness.message}`;
  }
}

export function integrationBranchLabel(
  snapshot: WorkSnapshot,
  repository: Repository,
  configured?: Branch,
): string {
  if (configured !== undefined) return `${configured} (configured)`;
  const state = snapshot.durable.repositoryStates.find((entry) => entry.repository === repository);
  const branch = state?.integrationBranch ?? state?.inferredIntegrationBranch;
  if (branch === undefined) return "Unknown (not inferred)";
  return `${branch} (${state?.source ?? "inferred"})`;
}

export function interruptedSetupLabel(
  snapshot: WorkSnapshot,
  topicId: TopicId,
): string | undefined {
  const topic = snapshot.durable.topics.find((entry) => entry.topic.id === topicId)?.topic;
  if (topic?.setup.state === "setup-interrupted") return "Interrupted Setup";
  const operation = snapshot.durable.operations.find((entry) => entry.topicId === topicId);
  return operation?.state === "setup-interrupted" ? "Interrupted Setup" : undefined;
}

export interface EffectDashboardRuntimeOptions {
  readonly socketPath?: string;
  readonly client?: WorkClientRuntime;
  readonly onChange: (state: EffectDashboardState) => void;
  readonly shimmerIntervalMs?: number;
}

/**
 * One per-view driver. Its client owns one ManagedRuntime and all stream, schedule, mutation,
 * operation-watch, and reconnect fibers. No command is replayed when a stream reconnects.
 */
export class EffectDashboardRuntime {
  private state = initialEffectDashboardState();
  private readonly client: WorkClientRuntime;
  private readonly onChange: (state: EffectDashboardState) => void;
  private readonly operationWatches = new Map<string, () => void>();
  private readonly mutations = new Map<string, Promise<DurableOperationResult>>();
  private cancellationRequest: Promise<DashboardCancellation> | undefined;
  private stopState: (() => void) | undefined;
  private stopShimmer: (() => void) | undefined;
  private partitionTail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(options: EffectDashboardRuntimeOptions) {
    if (options.client === undefined && options.socketPath === undefined) {
      throw new Error("The dashboard runtime needs a socket path or a client.");
    }
    this.onChange = options.onChange;
    this.client =
      options.client ??
      makeWorkClientRuntime({
        socketPath: options.socketPath!,
        onTransientError: (error) =>
          this.dispatch({ _tag: "StreamFailed", message: errorMessage(error) }),
      });
    this.stopState = this.client.subscribeState(
      (item) => this.dispatch({ _tag: "StreamItem", item }, options.shimmerIntervalMs),
      (error) => this.dispatch({ _tag: "StreamFailed", message: errorMessage(error) }),
    );
  }

  snapshotState(): EffectDashboardState {
    return this.state;
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.client.ephemeralAction("refresh-local"),
      this.client.ephemeralAction("refresh-integration"),
    ]);
    void this.client.ephemeralAction("refresh-pull-requests").catch(() => undefined);
  }

  mutate(key: string, command: TopicCommand): Promise<DurableOperationResult> {
    const active = this.mutations.get(key);
    if (active !== undefined) return active;
    const requestId = RequestId.make(randomUUID());
    const request = this.client.atomicCommand(command, requestId).finally(() => {
      if (this.mutations.get(key) === request) this.mutations.delete(key);
    });
    this.mutations.set(key, request);
    return request;
  }

  /** Serializes Partition keypresses in input order and gives each press one stable request ID. */
  movePartition(topicId: TopicId, direction: "up" | "down"): Promise<DurableOperationResult> {
    const requestId = RequestId.make(randomUUID());
    const run = () =>
      this.client.atomicCommand({ _tag: "MovePartition", topicId, direction }, requestId);
    const result = this.partitionTail.then(run, run);
    this.partitionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  resetIntegrationBranch(
    repository: Repository,
    expectedRevision?: number,
  ): Promise<DurableOperationResult> {
    const revision =
      expectedRevision ??
      this.state.snapshot?.durable.repositoryStates.find((entry) => entry.repository === repository)
        ?.rowRevision ??
      0;
    return this.mutate(`integration-branch:${repository}`, {
      _tag: "ResetIntegrationBranch",
      repository,
      expectedRevision: revision,
    });
  }

  /** Cancel Setup is always two-step: request a direct capability, then confirm it. */
  requestCancelSetup(operationId: OperationId): Promise<DashboardCancellation> {
    if (this.state.cancellation !== undefined) {
      return Promise.reject(new Error("A Setup cancellation is already awaiting confirmation."));
    }
    if (this.cancellationRequest !== undefined) return this.cancellationRequest;
    const active = this.state.snapshot?.durable.operations.find(
      (operation) => operation.id === operationId,
    );
    if (
      active === undefined ||
      (active.state !== "accepted" && active.state !== "running") ||
      active.input.kind !== "topic.provision"
    ) {
      return Promise.reject(new Error("Cancel Setup is available only for active provisioning."));
    }
    const request = this.client
      .requestOperationCancellation(operationId, 60_000)
      .then(({ confirmation }) => {
        const cancellation = {
          operationId,
          confirmation,
          text: "Cancel Setup? Completed checkpoints and external artifacts remain.",
        };
        this.state = { ...this.state, cancellation, message: cancellation.text };
        this.onChange(this.state);
        return cancellation;
      })
      .finally(() => {
        if (this.cancellationRequest === request) this.cancellationRequest = undefined;
      });
    this.cancellationRequest = request;
    return request;
  }

  async confirmCancelSetup(): Promise<DurableOperation> {
    const pending = this.state.cancellation;
    if (pending === undefined) throw new Error("No Setup cancellation is awaiting confirmation.");
    const { cancellation: _removed, ...state } = this.state;
    this.state = { ...state, message: "Setup cancellation requested." };
    this.onChange(this.state);
    const result = await this.client.confirmOperation(pending.operationId, pending.confirmation);
    this.dispatch({ _tag: "OperationUpdated", operation: result });
    return result;
  }

  rejectCancelSetup(): Promise<void> {
    if (this.state.cancellation === undefined) {
      return Promise.reject(new Error("No Setup cancellation is awaiting confirmation."));
    }
    const { cancellation: _removed, ...state } = this.state;
    this.state = { ...state, message: "Setup cancellation rejected. Provisioning continues." };
    this.onChange(this.state);
    return Promise.resolve();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stopState?.();
    this.stopState = undefined;
    this.stopShimmer?.();
    this.stopShimmer = undefined;
    for (const stop of this.operationWatches.values()) stop();
    this.operationWatches.clear();
    await this.client.dispose();
  }

  private dispatch(event: DashboardRuntimeEvent, shimmerIntervalMs = 80): void {
    if (this.disposed) return;
    this.state = reduceEffectDashboardState(this.state, event);
    this.syncOperationWatches();
    this.syncShimmer(shimmerIntervalMs);
    this.onChange(this.state);
  }

  private syncOperationWatches(): void {
    const active = new Set(
      (this.state.snapshot?.durable.operations ?? [])
        .filter(
          (operation) =>
            operation.state === "accepted" ||
            operation.state === "awaiting-confirmation" ||
            operation.state === "running",
        )
        .map((operation) => operation.id),
    );
    for (const [id, stop] of this.operationWatches) {
      if (!active.has(id as OperationId)) {
        stop();
        this.operationWatches.delete(id);
      }
    }
    for (const id of active) {
      if (this.operationWatches.has(id)) continue;
      this.operationWatches.set(
        id,
        this.client.watchOperation(id, (operation) =>
          this.dispatch({ _tag: "OperationUpdated", operation }),
        ),
      );
    }
  }

  private syncShimmer(intervalMs: number): void {
    const renderedTopicIds = new Set(
      (this.state.snapshot?.durable.topics ?? []).map((entry) => entry.topic.id),
    );
    const shimmering = (this.state.snapshot?.observed.topics ?? []).some(
      (entry) =>
        renderedTopicIds.has(entry.topicId) &&
        isShimmeringMainAgentActivity(entry.value?.mainAgentActivity),
    );
    if (shimmering && this.stopShimmer === undefined) {
      this.stopShimmer = this.client.repeat(intervalMs, () => this.dispatch({ _tag: "Shimmer" }));
    } else if (!shimmering && this.stopShimmer !== undefined) {
      this.stopShimmer();
      this.stopShimmer = undefined;
    }
  }
}

function boundedOperationUpdates(
  current: Readonly<Record<string, DurableOperation>>,
  operation: DurableOperation,
): Readonly<Record<string, DurableOperation>> {
  const entries = Object.entries({ ...current, [operation.id]: operation });
  return Object.fromEntries(entries.slice(-MAX_PROJECTED_OPERATIONS));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The Work dashboard disconnected.";
}
