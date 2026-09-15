import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import {
  DomainFailure,
  PolicyFailure,
  type AbsolutePath,
  type Branch,
  type ClientId,
  type DurableOperationResult,
  type IntegrationTarget,
  type PublicWorkFailure,
  type Repository,
  type RequestId,
  type TopicId,
} from "../../domain/index.ts";
import {
  planChainMove,
  planChildActivation,
  planChangeParent,
  planIntegrationTargetReset,
  planRemoveParent,
  planTopicDeletion,
  type AncestryLookup,
  type ChainPlan,
  type ChainResult,
} from "../../shared/integration-chain.ts";
import { planPartitionMove } from "../../shared/partition.ts";
import {
  familyKey,
  partitionKey,
  repositoryKey,
  topicKey,
  type KeyedConcurrency,
} from "../../infrastructure/concurrency/index.ts";
import type {
  RevisionedRepositoryState,
  RevisionedTopic,
  TopicRepositoryService,
} from "../../infrastructure/storage/index.ts";
import type { OperationEngine } from "../operation/index.ts";
import type { WorkStateProjection } from "../state/index.ts";

export type TopicCommand =
  | { readonly _tag: "Rename"; readonly topicId: TopicId; readonly name: string }
  | { readonly _tag: "SetNote"; readonly topicId: TopicId; readonly note: string }
  | {
      readonly _tag: "MovePartition";
      readonly topicId: TopicId;
      readonly direction: "up" | "down";
    }
  | {
      readonly _tag: "ChangeParent";
      readonly topicId: TopicId;
      readonly parentTopicId: TopicId;
    }
  | { readonly _tag: "RemoveParent"; readonly topicId: TopicId }
  | {
      readonly _tag: "MoveInChain";
      readonly topicId: TopicId;
      readonly target: IntegrationTarget;
      /** Set only after a direct confirmation of the reported broken edge. */
      readonly confirmed?: boolean;
    }
  | { readonly _tag: "ResetIntegrationTarget"; readonly topicId: TopicId }
  | { readonly _tag: "ActivatePendingChild"; readonly topicId: TopicId }
  | { readonly _tag: "Delete"; readonly topicId: TopicId };

export interface AtomicCommandRequest {
  readonly clientId: ClientId;
  readonly requestId: RequestId;
  readonly command: TopicCommand;
}

export interface IntegrationBranchControl {
  /** Human configuration override. It always wins over inferred storage. */
  readonly configured: (
    repository: Repository,
  ) => Effect.Effect<Branch | undefined, PublicWorkFailure>;
  /** Read-only local Git inference. */
  readonly infer: (
    repository: Repository,
    repositoryPath: AbsolutePath,
  ) => Effect.Effect<Branch | undefined, PublicWorkFailure>;
}

export interface StableAncestryControl {
  /** Reads all named tips before and after ancestry planning and fails if one moves. */
  readonly readStable: (input: {
    readonly repositoryPath: AbsolutePath;
    readonly integrationBranch: Branch;
    readonly topics: ReadonlyArray<RevisionedTopic>;
  }) => Effect.Effect<AncestryLookup, PublicWorkFailure>;
}

export interface TopicCommandOptions {
  readonly topics: TopicRepositoryService;
  readonly operations: OperationEngine;
  readonly state: WorkStateProjection;
  readonly concurrency: KeyedConcurrency;
  readonly ancestry: StableAncestryControl;
  readonly integrationBranches: IntegrationBranchControl;
  readonly repositoryPath: (repository: Repository) => AbsolutePath;
  /** Starts a safe local observation after inferred state is cleared. */
  readonly refreshAfterIntegrationBranchReset?: Effect.Effect<void, never>;
  readonly now?: Effect.Effect<string>;
}

export interface TopicCommands {
  /** Runs one idempotent short command. Callers supply intent, not repository writes. */
  readonly execute: (
    request: AtomicCommandRequest,
  ) => Effect.Effect<DurableOperationResult, PublicWorkFailure>;
  readonly effectiveIntegrationBranch: (
    repository: Repository,
  ) => Effect.Effect<Branch | undefined, PublicWorkFailure>;
  readonly resetIntegrationBranch: (
    request: Pick<AtomicCommandRequest, "clientId" | "requestId"> & {
      readonly repository: Repository;
      readonly expectedRevision: number;
    },
  ) => Effect.Effect<DurableOperationResult, PublicWorkFailure>;
}

/**
 * Makes the transactional Topic command boundary. Planning and Git reads happen before the
 * repository transaction. Each accepted transaction has one matching state publication.
 */
export function makeTopicCommands(options: TopicCommandOptions): TopicCommands {
  const now =
    options.now ??
    Clock.currentTimeMillis.pipe(Effect.map((value) => new Date(value).toISOString()));

  const publishTopics = (
    values: ReadonlyArray<RevisionedTopic>,
    remove: ReadonlyArray<TopicId> = [],
  ) =>
    options.state
      .publish({
        _tag: "DurableCommitted",
        topics: {
          upsert: values.map((value) => ({ topic: value.topic, rowRevision: value.revision })),
          ...(remove.length === 0 ? {} : { remove }),
        },
      })
      .pipe(Effect.asVoid);

  const publishRepository = (value: RevisionedRepositoryState) =>
    options.state
      .publish({
        _tag: "DurableCommitted",
        repositoryStates: {
          upsert: [
            {
              repository: value.repository,
              integrationBranch: value.inferredIntegrationBranch,
              source: "inferred",
              inferredIntegrationBranch: value.inferredIntegrationBranch,
              rowRevision: value.revision,
              updatedAt: value.updatedAt,
            },
          ],
        },
      })
      .pipe(Effect.asVoid);

  const publishRepositoryRemoval = (repository: Repository) =>
    options.state
      .publish({
        _tag: "DurableCommitted",
        repositoryStates: { remove: [repository] },
      })
      .pipe(Effect.asVoid);

  const configuredOrStored = (repository: Repository) =>
    options.integrationBranches
      .configured(repository)
      .pipe(
        Effect.flatMap((configured) =>
          configured === undefined
            ? options.topics
                .getInferredIntegrationBranch(repository)
                .pipe(Effect.map((stored) => stored?.inferredIntegrationBranch))
            : Effect.succeed(configured),
        ),
      );

  const ensureInferred = (repository: Repository) =>
    options.concurrency.withKeys(
      [repositoryKey(repository)],
      Effect.gen(function* () {
        const current = yield* options.topics.getInferredIntegrationBranch(repository);
        if (current !== undefined) return current;
        const inferred = yield* options.integrationBranches.infer(
          repository,
          options.repositoryPath(repository),
        );
        if (inferred === undefined) return undefined;
        const stored = yield* options.topics.storeInferredIntegrationBranch(
          repository,
          inferred,
          undefined,
          yield* now,
        );
        yield* publishRepository(stored);
        return stored;
      }),
    );

  const effectiveIntegrationBranch = (repository: Repository) =>
    options.integrationBranches
      .configured(repository)
      .pipe(
        Effect.flatMap((configured) =>
          configured === undefined
            ? ensureInferred(repository).pipe(
                Effect.map((stored) => stored?.inferredIntegrationBranch),
              )
            : Effect.succeed(configured),
        ),
      );

  const commandEffect = (
    command: TopicCommand,
  ): Effect.Effect<DurableOperationResult, PublicWorkFailure> =>
    Effect.gen(function* () {
      const initial = yield* options.topics.get(command.topicId);
      const rootId = initial.topic.parentTopicId ?? initial.topic.id;
      const keys =
        command._tag === "MovePartition"
          ? [partitionKey(initial.topic.repository)]
          : [topicKey(command.topicId), familyKey(rootId), repositoryKey(initial.topic.repository)];
      if (command._tag === "ChangeParent") keys.push(familyKey(command.parentTopicId));

      return yield* options.concurrency.withKeys(
        keys,
        Effect.gen(function* () {
          const values = yield* options.topics.list;
          const current = requireTopic(values, command.topicId);
          let committed: ReadonlyArray<RevisionedTopic>;

          switch (command._tag) {
            case "Rename": {
              const name = command.name.trim();
              if (name.length === 0 || name.length > 200) {
                return yield* invalid(
                  "Topic name must contain from 1 through 200 characters.",
                  command.topicId,
                );
              }
              const changed = yield* options.topics.update(
                { ...current.topic, name, updatedAt: yield* now },
                current.revision,
              );
              committed = [changed];
              break;
            }
            case "SetNote": {
              const note = command.note.trim();
              if (note.length > 200) {
                return yield* invalid(
                  "Topic Note must not exceed 200 characters.",
                  command.topicId,
                );
              }
              const { note: _old, ...withoutNote } = current.topic;
              const changed = yield* options.topics.update(
                {
                  ...withoutNote,
                  ...(note.length === 0 ? {} : { note }),
                  updatedAt: yield* now,
                },
                current.revision,
              );
              committed = [changed];
              break;
            }
            case "MovePartition": {
              const family = familyOf(values, current);
              const arrangement = planPartitionMove(
                values.map(({ topic }) => topic),
                new Set(family.map(({ topic }) => topic.id)),
                current.topic.id,
                command.direction,
              );
              if (arrangement === undefined) committed = [];
              else {
                const changed = values.filter(
                  ({ topic }) => arrangement.get(topic.id) !== topic.partition,
                );
                committed =
                  changed.length === 0
                    ? []
                    : yield* options.topics.updateFamilyPartition({
                        family: family.map(({ topic }) => topic.id),
                        arrangement: changed.map((value) => ({
                          topicId: value.topic.id,
                          revision: value.revision,
                          partition: arrangement.get(value.topic.id)!,
                        })),
                      });
              }
              break;
            }
            case "RemoveParent": {
              const plan = requirePlan(
                planRemoveParent({
                  topics: values.map(({ topic }) => topic),
                  topicId: current.topic.id,
                }),
                current.topic.id,
              );
              committed = yield* options.topics.applyChainPlan(toWrite(plan, values));
              break;
            }
            case "Delete": {
              const plan = requirePlan(
                planTopicDeletion({
                  topics: values.map(({ topic }) => topic),
                  topicId: current.topic.id,
                }),
                current.topic.id,
              );
              committed = yield* options.topics.deleteWithChainRepair(
                current.topic.id,
                current.revision,
                toWrite(plan, values),
              );
              yield* publishTopics(committed, [current.topic.id]);
              return success(command, current.topic.id);
            }
            default: {
              const plan = yield* gitPlan(options, values, current, command, configuredOrStored);
              if (
                plan.confirmationRequired !== undefined &&
                (command._tag !== "MoveInChain" || command.confirmed !== true)
              ) {
                return yield* Effect.fail(
                  new PolicyFailure({
                    reason: "confirmation-required",
                    message: plan.confirmationRequired,
                    details: { topicId: current.topic.id },
                  }),
                );
              }
              const partition =
                command._tag === "ChangeParent"
                  ? requireTopic(values, command.parentTopicId).topic.partition
                  : undefined;
              committed =
                plan.edits.length === 0
                  ? []
                  : yield* options.topics.applyChainPlan(
                      toWrite(
                        plan,
                        values,
                        command._tag === "ChangeParent"
                          ? { topicId: current.topic.id, partition: partition! }
                          : undefined,
                      ),
                    );
            }
          }
          if (committed.length > 0) yield* publishTopics(committed);
          return success(command, current.topic.id);
        }),
      );
    });

  const execute = (request: AtomicCommandRequest) =>
    options.operations.executeAtomicCommand(
      {
        clientId: request.clientId,
        requestId: request.requestId,
        fingerprint: stableFingerprint(request.command),
      },
      commandEffect(request.command),
    );

  const resetIntegrationBranch: TopicCommands["resetIntegrationBranch"] = (request) =>
    options.operations.executeAtomicCommand(
      {
        clientId: request.clientId,
        requestId: request.requestId,
        fingerprint: `integration-branch.reset:${request.repository}:${request.expectedRevision}`,
      },
      options.concurrency
        .withKeys(
          [repositoryKey(request.repository)],
          Effect.gen(function* () {
            const configured = yield* options.integrationBranches.configured(request.repository);
            if (configured !== undefined) {
              return yield* Effect.fail(
                new DomainFailure({
                  reason: "invalid-relationship",
                  message: "The Integration Branch has an explicit configured override.",
                }),
              );
            }
            const current = yield* options.topics.getInferredIntegrationBranch(request.repository);
            if (current === undefined) {
              return yield* Effect.fail(
                new DomainFailure({
                  reason: "invalid-relationship",
                  message: "The repository has no inferred Integration Branch to reset.",
                }),
              );
            }
            yield* options.topics.clearInferredIntegrationBranch(
              request.repository,
              request.expectedRevision,
            );
            yield* publishRepositoryRemoval(request.repository);
            return {
              version: 1 as const,
              status: "succeeded" as const,
              value: { command: "ResetIntegrationBranch", repository: request.repository },
            };
          }),
        )
        .pipe(Effect.tap(() => options.refreshAfterIntegrationBranchReset ?? Effect.void)),
    );

  return { execute, effectiveIntegrationBranch, resetIntegrationBranch };
}

function requireTopic(values: ReadonlyArray<RevisionedTopic>, topicId: TopicId): RevisionedTopic {
  const value = values.find(({ topic }) => topic.id === topicId);
  if (value === undefined) {
    throw new DomainFailure({
      reason: "not-found",
      message: "Topic does not exist.",
      details: { topicId },
    });
  }
  return value;
}

function familyOf(values: ReadonlyArray<RevisionedTopic>, selected: RevisionedTopic) {
  const root = selected.topic.parentTopicId ?? selected.topic.id;
  return values.filter(({ topic }) => topic.id === root || topic.parentTopicId === root);
}

function invalid(message: string, topicId: TopicId) {
  return Effect.fail(new DomainFailure({ reason: "invalid-input", message, details: { topicId } }));
}

function requirePlan(result: ChainResult<ChainPlan>, topicId: TopicId): ChainPlan {
  if (result.ok) return result.value;
  throw new DomainFailure({
    reason: "invalid-relationship",
    message: result.error.message,
    details: { topicId },
  });
}

function toWrite(
  plan: ChainPlan,
  values: ReadonlyArray<RevisionedTopic>,
  partition?: { readonly topicId: TopicId; readonly partition: number },
) {
  const edits = plan.edits.map((edit) => ({
    topicId: edit.topicId as TopicId,
    ...(edit.parentTopicId === undefined
      ? {}
      : { parentTopicId: edit.parentTopicId as TopicId | null }),
    ...(edit.integrationTarget === undefined
      ? {}
      : {
          integrationTarget:
            edit.integrationTarget.kind === "integration-branch"
              ? edit.integrationTarget
              : { kind: "topic" as const, topicId: edit.integrationTarget.topicId as TopicId },
        }),
    ...(edit.chainState === undefined ? {} : { chainState: edit.chainState }),
    ...(partition?.topicId === edit.topicId ? { partition: partition.partition } : {}),
  }));
  return {
    edits,
    expected: edits.map((edit) => ({
      topicId: edit.topicId,
      revision: requireTopic(values, edit.topicId).revision,
    })),
  };
}

function gitPlan(
  options: TopicCommandOptions,
  values: ReadonlyArray<RevisionedTopic>,
  current: RevisionedTopic,
  command: Exclude<
    TopicCommand,
    { _tag: "Rename" | "SetNote" | "MovePartition" | "RemoveParent" | "Delete" }
  >,
  effectiveBranch: (repository: Repository) => Effect.Effect<Branch | undefined, PublicWorkFailure>,
): Effect.Effect<ChainPlan, PublicWorkFailure> {
  const repositoryTopics = values.filter(
    ({ topic }) => topic.repository === current.topic.repository,
  );
  return effectiveBranch(current.topic.repository).pipe(
    Effect.flatMap((integrationBranch) =>
      integrationBranch === undefined
        ? Effect.fail(
            new DomainFailure({
              reason: "invalid-relationship",
              message: "The repository has no Integration Branch.",
              details: { topicId: current.topic.id },
            }),
          )
        : options.ancestry
            .readStable({
              repositoryPath: options.repositoryPath(current.topic.repository),
              integrationBranch,
              topics: repositoryTopics,
            })
            .pipe(
              Effect.map((ancestry) =>
                requirePlan(planCommand(command, values, current, ancestry), current.topic.id),
              ),
            ),
    ),
  );
}

function planCommand(
  command: Exclude<
    TopicCommand,
    { _tag: "Rename" | "SetNote" | "MovePartition" | "RemoveParent" | "Delete" }
  >,
  values: ReadonlyArray<RevisionedTopic>,
  current: RevisionedTopic,
  ancestry: AncestryLookup,
): ChainResult<ChainPlan> {
  const topics = values.map(({ topic }) => topic);
  switch (command._tag) {
    case "ChangeParent":
      return planChangeParent({
        topics,
        topicId: command.topicId,
        newParentTopicId: command.parentTopicId,
        ancestry,
      });
    case "MoveInChain":
      return planChainMove({ topics, topicId: command.topicId, target: command.target, ancestry });
    case "ResetIntegrationTarget":
      return planIntegrationTargetReset({
        topics,
        parentTopicId: current.topic.parentTopicId ?? current.topic.id,
        ancestry,
      });
    case "ActivatePendingChild":
      return planChildActivation({ topics, topicId: command.topicId, ancestry });
  }
}

function success(command: TopicCommand, topicId: TopicId): DurableOperationResult {
  return { version: 1, status: "succeeded", value: { command: command._tag, topicId } };
}

function stableFingerprint(command: TopicCommand): string {
  return `topic-command:${JSON.stringify(command)}`;
}
