import { userInfo } from "node:os";
import { stripVTControlCharacters } from "node:util";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AbsolutePath,
  ActionId,
  ActionPolicy,
  DurableTopic,
  FullCommitSha,
  boundPublicMessage,
  OperationFailure,
  PolicyFailure,
  RepositoryRecipe,
  StartPoint,
  type Branch,
  type DurableOperationInput,
  type DurableOperationResult,
  type PublicWorkFailure,
  type Repository,
  type TopicId,
  type TopicSetup,
} from "../../domain/index.ts";
import {
  creationKey,
  repositoryKey,
  topicKey,
  type KeyedConcurrency,
} from "../../infrastructure/concurrency/index.ts";
import type { ProcessResult } from "../../infrastructure/process/index.ts";
import type { RevisionedTopic, TopicRepository } from "../../infrastructure/storage/index.ts";
import type { WorkStateProjection } from "../state/index.ts";
import type {
  OperationEngine,
  OperationStart,
  OperationWorker,
  OperationWorkerContext,
} from "../operation/index.ts";
import type { OperationRepository } from "../operation/repository.ts";

const SETUP_TIMEOUT_MS = 5 * 60_000;
const SETUP_OUTPUT_BYTES = 64 * 1_024;

const ProvisionPolicySnapshot = Schema.Record(ActionId, ActionPolicy);
export const ProvisionOperationValue = Schema.Struct({
  attempt: Schema.Literals(["create-root", "create-child", "retry"]),
  topic: DurableTopic,
  workBase: AbsolutePath,
  recipe: RepositoryRecipe,
  policies: ProvisionPolicySnapshot,
  startPoint: Schema.optional(StartPoint),
});
export type ProvisionOperationValue = typeof ProvisionOperationValue.Type;

export interface ProvisioningControl {
  readonly inspectBaseCheckout: (
    workBase: AbsolutePath,
    baseCheckout: AbsolutePath,
    repository: Repository,
  ) => Effect.Effect<"missing" | "valid", PublicWorkFailure>;
  readonly cloneRepository: (
    workBase: AbsolutePath,
    baseCheckout: AbsolutePath,
    repository: Repository,
  ) => Effect.Effect<void, PublicWorkFailure>;
  readonly validateStartPoint: (
    baseCheckout: AbsolutePath,
    startPoint: typeof StartPoint.Type,
  ) => Effect.Effect<void, PublicWorkFailure>;
  readonly ensureBranch: (
    baseCheckout: AbsolutePath,
    branch: Branch,
    commit: FullCommitSha,
  ) => Effect.Effect<void, PublicWorkFailure>;
  readonly discoverWorktree: (
    baseCheckout: AbsolutePath,
    branch: Branch,
  ) => Effect.Effect<AbsolutePath | undefined, PublicWorkFailure>;
  readonly createWorktree: (
    baseCheckout: AbsolutePath,
    branch: Branch,
    allowBranchCreation: boolean,
  ) => Effect.Effect<AbsolutePath, PublicWorkFailure>;
  readonly validateWorktree: (input: {
    readonly baseCheckout: AbsolutePath;
    readonly worktreePath: AbsolutePath;
    readonly repository: Repository;
    readonly branch: Branch;
    readonly commit?: FullCommitSha;
  }) => Effect.Effect<void, PublicWorkFailure>;
}

export interface ProvisioningWorkerOptions {
  readonly topics: TopicRepository;
  readonly operations: OperationRepository;
  readonly state: WorkStateProjection;
  readonly concurrency: KeyedConcurrency;
  readonly control: ProvisioningControl;
  /** Scoped process adapter. Interruption must stop the complete owned process group. */
  readonly runSetupCommand: (request: {
    readonly shell: string;
    readonly command: string;
    readonly cwd: AbsolutePath;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }) => Effect.Effect<ProcessResult, PublicWorkFailure>;
  readonly setupShell?: string;
  readonly setupTimeoutMs?: number;
  readonly setupOutputBytes?: number;
  /** Activates a pending child after all provisioning state is durable. */
  readonly activatePendingChild?: (topicId: TopicId) => Effect.Effect<void, PublicWorkFailure>;
}

/** Starts accepted provisioning through the Durable Operation engine. */
export interface ProvisioningService {
  readonly start: (
    request: Omit<OperationStart, "input" | "topicId" | "confirmation"> & {
      readonly value: ProvisionOperationValue;
      readonly confirmationLifetimeMs?: number;
    },
  ) => ReturnType<OperationEngine["start"]>;
}

export function makeProvisioningService(engine: OperationEngine): ProvisioningService {
  return {
    start: (request) => {
      const input: DurableOperationInput = {
        version: 1,
        kind: "topic.provision",
        value: request.value,
      };
      const confirmationActions = sensitiveActions(request.value).filter(
        (action) => request.value.policies[action] === "ask",
      );
      return engine.start({
        clientId: request.clientId,
        requestId: request.requestId,
        fingerprint: request.fingerprint,
        input,
        phase: request.phase ?? "accepted",
        ...(confirmationActions.length > 0
          ? {
              confirmation: {
                action: confirmationActions.join("+"),
                text: provisioningConfirmationText(request.value, confirmationActions),
                lifetimeMs: request.confirmationLifetimeMs ?? 60_000,
                durable: true,
              },
            }
          : {}),
      });
    },
  };
}

/** Makes the resumable worker registered as `topic.provision` in OperationEngine. */
export function makeProvisioningWorker(options: ProvisioningWorkerOptions): OperationWorker {
  const shell = options.setupShell ?? defaultLoginShell();
  return {
    resumable: true,
    run: (context) =>
      decodeInput(context.operation.input).pipe(
        Effect.flatMap((input) =>
          options.concurrency
            .withKeys(
              [
                topicKey(input.topic.id),
                repositoryKey(input.topic.repository),
                creationKey(input.topic.repository, input.topic.branch),
              ],
              runAttempt(options, context, input, shell).pipe(
                Effect.catch((failure) =>
                  markTopicSetup(options, input.topic.id, "setup-failed", failure.message).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.andThen(Effect.fail(failure)),
                  ),
                ),
              ),
            )
            .pipe(
              Effect.tap(() =>
                input.topic.chainState === "pending"
                  ? (options.activatePendingChild?.(input.topic.id) ?? Effect.void)
                  : Effect.void,
              ),
            ),
        ),
      ),
    interrupted: (operation) =>
      decodeInput(operation.input).pipe(
        Effect.flatMap((input) =>
          markTopicSetup(
            options,
            input.topic.id,
            "setup-interrupted",
            "Setup lost supervision. Use Retry Setup.",
          ),
        ),
      ),
  };
}

function runRetryAttempt(
  options: ProvisioningWorkerOptions,
  context: OperationWorkerContext,
  input: ProvisionOperationValue,
  shell: string,
  initial: RevisionedTopic,
): Effect.Effect<DurableOperationResult, PublicWorkFailure> {
  return Effect.gen(function* () {
    if (
      initial.topic.setup.state !== "setup-failed" &&
      initial.topic.setup.state !== "setup-interrupted"
    ) {
      return yield* failOperation(
        "Retry Setup is available only after Setup failed or was interrupted.",
        initial.topic.id,
      );
    }
    const worktreePath = initial.topic.worktreePath;
    if (worktreePath === null) {
      return yield* failOperation(
        "Retry Setup requires the existing Topic Worktree.",
        initial.topic.id,
      );
    }

    yield* requirePolicy(input, "topic.run-setup");
    yield* context.progress("base-checkout-validation");
    const baseCheckout =
      input.recipe.basePath ?? defaultBaseCheckout(input.workBase, input.topic.repository);
    const base = yield* options.control.inspectBaseCheckout(
      input.workBase,
      baseCheckout,
      input.topic.repository,
    );
    if (base === "missing") {
      return yield* failOperation(
        "Retry Setup requires the existing Base checkout.",
        initial.topic.id,
      );
    }
    yield* context.progress("worktree-validation");
    yield* options.control.validateWorktree({
      baseCheckout,
      worktreePath,
      repository: initial.topic.repository,
      branch: initial.topic.branch,
    });

    let stored = yield* updateSetup(options, initial, {
      ...initial.topic.setup,
      state: "provisioning",
      setupCommandsRun: false,
      completedCommandCount: 0,
    });
    for (let index = 0; index < input.recipe.setupCommands.length; index += 1) {
      yield* context.progress(`setup ${index + 1}/${input.recipe.setupCommands.length}`);
      const operation = yield* options.operations.get(context.operation.id);
      const step = yield* options.operations.startSetupStep(
        context.operation.id,
        index,
        operation.revision,
        yield* nowIso,
      );
      const result = yield* options.runSetupCommand({
        shell,
        command: input.recipe.setupCommands[index]!,
        cwd: worktreePath,
        timeoutMs: options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
        maxOutputBytes: options.setupOutputBytes ?? SETUP_OUTPUT_BYTES,
      });
      if (result.status !== "completed" || result.exitCode !== 0) {
        return yield* failOperation(
          setupCommandFailure(result, index, input.recipe.setupCommands.length),
          initial.topic.id,
        );
      }
      yield* options.operations.completeSetupStep(
        context.operation.id,
        index,
        step.revision,
        yield* nowIso,
      );
      stored = yield* updateSetup(options, stored, {
        ...stored.topic.setup,
        completedCommandCount: index + 1,
      });
    }
    stored = yield* updateSetup(options, stored, {
      ...stored.topic.setup,
      setupCommandsRun: true,
      completedCommandCount: input.recipe.setupCommands.length,
    });
    yield* context.progress("ready");
    const { reason: _, ...setupWithoutReason } = stored.topic.setup;
    stored = yield* updateSetup(options, stored, { ...setupWithoutReason, state: "ready" });
    return {
      version: 1,
      status: "succeeded",
      value: { topicId: stored.topic.id, state: "ready" },
    };
  });
}

function setupCommandFailure(result: ProcessResult, index: number, total: number): string {
  const subject = `Setup command ${index + 1} of ${total}`;
  if (result.status === "timeout") return `${subject} timed out.`;
  if (result.status === "cancelled") return `${subject} was cancelled.`;
  const failure =
    result.exitCode === null
      ? `${subject} failed.`
      : `${subject} failed with exit code ${result.exitCode}.`;
  const output = setupOutputExcerpt(result);
  if (output.length === 0) return failure;
  const separator = failure.endsWith(".") ? failure.slice(0, -1) : failure;
  return boundPublicMessage(`${separator}: ${output}`);
}

function setupOutputExcerpt(result: ProcessResult): string {
  const output = result.stderr.trim() || result.stdout.trim();
  return stripVTControlCharacters(output).replaceAll(/\s+/g, " ").trim();
}

function runAttempt(
  options: ProvisioningWorkerOptions,
  context: OperationWorkerContext,
  input: ProvisionOperationValue,
  shell: string,
): Effect.Effect<DurableOperationResult, PublicWorkFailure> {
  return Effect.gen(function* () {
    let stored = yield* getOrCreateTopic(options, input);
    if (context.operation.topicId === undefined) {
      const operation = yield* options.operations.attachTopic(
        context.operation.id,
        stored.topic.id,
        (yield* options.operations.get(context.operation.id)).revision,
        yield* nowIso,
      );
      yield* context.progress(operation.phase);
    }
    if (input.attempt === "retry") {
      return yield* runRetryAttempt(options, context, input, shell, stored);
    }

    yield* context.progress("base-checkout-validation");
    const baseCheckout =
      input.recipe.basePath ?? defaultBaseCheckout(input.workBase, input.topic.repository);
    const base = yield* options.control.inspectBaseCheckout(
      input.workBase,
      baseCheckout,
      input.topic.repository,
    );
    if (base === "missing") {
      yield* requirePolicy(input, "repository.clone");
      if (input.startPoint !== undefined) {
        return yield* failOperation(
          "A Start Point requires the configured Base checkout to exist.",
          input.topic.id,
        );
      }
      yield* context.progress("repository-clone");
      yield* options.control.cloneRepository(input.workBase, baseCheckout, input.topic.repository);
      yield* options.control.inspectBaseCheckout(
        input.workBase,
        baseCheckout,
        input.topic.repository,
      );
    }
    if (input.startPoint !== undefined) {
      yield* options.control.validateStartPoint(baseCheckout, input.startPoint);
    }
    stored = yield* updateSetup(options, stored, {
      ...stored.topic.setup,
      state: "provisioning",
      repositoryAvailable: true,
    });

    yield* context.progress("branch-validation");
    if (input.startPoint !== undefined) {
      yield* requirePolicy(input, "topic.create-worktree");
      yield* options.control.ensureBranch(
        baseCheckout,
        input.topic.branch,
        input.startPoint.commit,
      );
    }

    yield* context.progress("worktree-discovery");
    let worktreePath = yield* options.control.discoverWorktree(baseCheckout, input.topic.branch);
    let created = false;
    if (worktreePath === undefined) {
      yield* requirePolicy(input, "topic.create-worktree");
      yield* context.progress("worktree-creation");
      worktreePath = yield* options.control.createWorktree(
        baseCheckout,
        input.topic.branch,
        input.startPoint === undefined,
      );
      created = true;
    }
    yield* context.progress("worktree-validation");
    yield* options.control.validateWorktree({
      baseCheckout,
      worktreePath,
      repository: input.topic.repository,
      branch: input.topic.branch,
      ...(input.startPoint === undefined ? {} : { commit: input.startPoint.commit }),
    });

    const firstWorktreeCheckpoint = !stored.topic.setup.worktreeCreated;
    const setupCommandsRun = firstWorktreeCheckpoint
      ? !created
      : stored.topic.setup.setupCommandsRun;
    stored = yield* updateTopic(options, stored, {
      ...stored.topic,
      worktreePath,
      setup: {
        ...stored.topic.setup,
        state: "provisioning",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun,
      },
      updatedAt: yield* nowIso,
    });

    if (!stored.topic.setup.setupCommandsRun) {
      yield* requirePolicy(input, "topic.run-setup");
      const steps = yield* options.operations.listSteps(context.operation.id);
      for (let index = 0; index < input.recipe.setupCommands.length; index += 1) {
        const existing = steps.find((step) => step.index === index);
        if (existing?.state === "completed") continue;
        if (existing !== undefined) {
          return yield* failOperation(
            "Setup was interrupted. Use Retry Setup to start from command one.",
            input.topic.id,
            "setup-interrupted",
          );
        }
        yield* context.progress(`setup ${index + 1}/${input.recipe.setupCommands.length}`);
        const operation = yield* options.operations.get(context.operation.id);
        const step = yield* options.operations.startSetupStep(
          context.operation.id,
          index,
          operation.revision,
          yield* nowIso,
        );
        const result = yield* options.runSetupCommand({
          shell,
          command: input.recipe.setupCommands[index]!,
          cwd: worktreePath,
          timeoutMs: options.setupTimeoutMs ?? SETUP_TIMEOUT_MS,
          maxOutputBytes: options.setupOutputBytes ?? SETUP_OUTPUT_BYTES,
        });
        if (result.status !== "completed" || result.exitCode !== 0) {
          return yield* failOperation(
            setupCommandFailure(result, index, input.recipe.setupCommands.length),
            input.topic.id,
          );
        }
        yield* options.operations.completeSetupStep(
          context.operation.id,
          index,
          step.revision,
          yield* nowIso,
        );
        stored = yield* updateSetup(options, stored, {
          ...stored.topic.setup,
          completedCommandCount: index + 1,
        });
      }
      stored = yield* updateSetup(options, stored, {
        ...stored.topic.setup,
        setupCommandsRun: true,
        completedCommandCount: input.recipe.setupCommands.length,
      });
    }

    yield* context.progress("ready");
    const { reason: _, ...setupWithoutReason } = stored.topic.setup;
    stored = yield* updateSetup(options, stored, {
      ...setupWithoutReason,
      state: "ready",
    });
    return {
      version: 1,
      status: "succeeded",
      value: { topicId: stored.topic.id, state: "ready" },
    };
  });
}

function getOrCreateTopic(
  options: ProvisioningWorkerOptions,
  input: ProvisionOperationValue,
): Effect.Effect<RevisionedTopic, PublicWorkFailure> {
  return options.topics.list.pipe(
    Effect.flatMap((topics): Effect.Effect<RevisionedTopic, PublicWorkFailure> => {
      const existing = topics.find(({ topic }) => topic.id === input.topic.id);
      if (existing !== undefined) return Effect.succeed(existing);
      if (input.attempt !== "retry") return options.topics.create(input.topic);
      return Effect.fail(
        new OperationFailure({
          reason: "invalid-state",
          message: "Retry Setup requires an existing Topic.",
          details: { topicId: input.topic.id },
        }),
      );
    }),
    Effect.tap((topic) => publishTopic(options.state, topic)),
  );
}

function updateSetup(
  options: ProvisioningWorkerOptions,
  current: RevisionedTopic,
  setup: TopicSetup,
) {
  return options.topics
    .updateSetup(current.topic.id, setup, current.revision)
    .pipe(Effect.tap((topic) => publishTopic(options.state, topic)));
}

function updateTopic(
  options: ProvisioningWorkerOptions,
  current: RevisionedTopic,
  topic: DurableTopic,
) {
  return options.topics
    .update(topic, current.revision)
    .pipe(Effect.tap((value) => publishTopic(options.state, value)));
}

function publishTopic(state: WorkStateProjection, value: RevisionedTopic) {
  return state
    .publish({
      _tag: "DurableCommitted",
      topics: { upsert: [{ topic: value.topic, rowRevision: value.revision }] },
    })
    .pipe(Effect.asVoid);
}

function markTopicSetup(
  options: ProvisioningWorkerOptions,
  topicId: TopicId,
  state: "setup-failed" | "setup-interrupted",
  reason: string,
) {
  return options.topics.get(topicId).pipe(
    Effect.flatMap((current) =>
      updateSetup(options, current, {
        ...current.topic.setup,
        state,
        reason: reason.slice(0, 200),
      }),
    ),
    Effect.asVoid,
  );
}

function requirePolicy(input: ProvisionOperationValue, action: typeof ActionId.Type) {
  const policy = input.policies[action] ?? "deny";
  return policy === "deny"
    ? Effect.fail(
        new PolicyFailure({
          reason: "denied",
          message: `Policy denied ${action}.`,
          details: { topicId: input.topic.id },
        }),
      )
    : Effect.void;
}

/** Exact bounded text returned by the daemon for a direct provisioning confirmation. */
export function provisioningConfirmationText(
  input: ProvisionOperationValue,
  actions: ReadonlyArray<typeof ActionId.Type> = sensitiveActions(input).filter(
    (action) => input.policies[action] === "ask",
  ),
): string {
  return `Create and provision Topic “${input.topic.name}” in ${input.topic.repository} on Branch ${input.topic.branch}? Approve: ${actions.join(", ")}.`;
}

function sensitiveActions(input: ProvisionOperationValue): ReadonlyArray<typeof ActionId.Type> {
  if (input.attempt === "retry") return ["topic.run-setup"];
  const actions: Array<typeof ActionId.Type> = ["topic.create-worktree"];
  if (input.recipe.setupCommands.length > 0) actions.push("topic.run-setup");
  if (input.startPoint === undefined) actions.push("repository.clone");
  return actions;
}

function decodeInput(input: DurableOperationInput) {
  if (input.kind !== "topic.provision") {
    return Effect.fail(
      new OperationFailure({
        reason: "invalid-state",
        message: "The operation is not Topic provisioning.",
      }),
    );
  }
  return Schema.decodeUnknownEffect(ProvisionOperationValue)(input.value).pipe(
    Effect.mapError(
      () =>
        new OperationFailure({
          reason: "invalid-state",
          message: "The Topic provisioning input is invalid.",
        }),
    ),
  );
}

function defaultBaseCheckout(workBase: AbsolutePath, repository: Repository): AbsolutePath {
  return AbsolutePath.make(`${workBase}/${repository.slice(repository.indexOf("/") + 1)}`);
}

function defaultLoginShell(): string {
  try {
    return userInfo().shell || "/bin/sh";
  } catch {
    return "/bin/sh";
  }
}

function failOperation(
  message: string,
  topicId: TopicId,
  reason: "invalid-state" | "setup-interrupted" = "invalid-state",
) {
  return Effect.fail(new OperationFailure({ reason, message, details: { topicId } }));
}

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((value) => new Date(value).toISOString()));
