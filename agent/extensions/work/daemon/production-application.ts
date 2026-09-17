import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import {
  AbsolutePath,
  ClientId,
  DomainFailure,
  PolicyFailure,
  PrivateLocalCapability,
  RequestId,
  TopicId,
  WORK_PROTOCOL_VERSION,
  WORK_STORAGE_SCHEMA_VERSION,
  type Branch,
  type DurableTopic,
  type DurableOperationResult,
  type Policy,
  type Repository,
} from "../domain/index.ts";
import { makeWorkConfigurationService, type WorkConfiguration } from "../infrastructure/config.ts";
import { makeKeyedConcurrency } from "../infrastructure/concurrency/index.ts";
import { makeDesktopControl } from "../infrastructure/desktop/index.ts";
import { makeGitControl, makeTopicProvisioningControl } from "../infrastructure/git/index.ts";
import { makeGitHubPullRequests } from "../infrastructure/github/index.ts";
import { makeProcessExecutor, ProcessExecutor } from "../infrastructure/process/index.ts";
import type { MainAgentCallRequest } from "../infrastructure/rpc/client.ts";
import type { DaemonRuntimeLease, WorkRpcApplication } from "../infrastructure/rpc/index.ts";
import {
  OperationRepository,
  TopicRepository,
  operationRepositoryLayer,
  topicRepositoryLayer,
  type RevisionedRepositoryState,
} from "../infrastructure/storage/index.ts";
import { makeTopicCommands } from "../application/command/index.ts";
import {
  makeMainAgentLifecycle,
  type MainAgentLifecycle,
} from "../application/main-agent/index.ts";
import { makeObservationWorkers } from "../application/observation/index.ts";
import {
  makeOperationEngine,
  type DurableOperation,
  type OperationWorker,
} from "../application/operation/index.ts";
import {
  makeProvisioningService,
  makeProvisioningWorker,
  ProvisionOperationValue,
} from "../application/provisioning/index.ts";
import {
  boundProjectedOperations,
  makeWorkState,
  type WorkDurableProjection,
} from "../application/state/index.ts";
import type { WorkPaths } from "../shared/paths.ts";
import type { AncestryLookup, ChainNode } from "../shared/integration-chain.ts";
import { resolveActionPolicy, type WorkPolicies } from "../shared/policy.ts";

/** Composes the production SQLite, application, process, desktop, and observation modules. */
export function makeProductionWorkApplication(
  paths: WorkPaths,
  lease: DaemonRuntimeLease,
): Effect.Effect<
  WorkRpcApplication,
  any,
  Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.gen(function* () {
    const databasePath = join(paths.root, "work.db");
    const topicContext = yield* Layer.build(topicRepositoryLayer({ filename: databasePath }));
    const operationContext = yield* Layer.build(
      operationRepositoryLayer({ filename: databasePath }),
    );
    const topics = Context.get(topicContext, TopicRepository);
    const operationRepository = Context.get(operationContext, OperationRepository);
    const configurationService = yield* makeWorkConfigurationService(paths.config);
    const configuration = yield* configurationService.validateStartup;
    const topicRows = yield* topics.list;
    const operationRows = yield* (
      operationRepository.listAll?.() ?? operationRepository.listActive()
    );
    const repositoryRows = yield* topics.listInferredIntegrationBranches?.() ?? Effect.succeed([]);
    const daemonStartedAt = new Date().toISOString();
    const state = yield* makeWorkState({
      daemon: { id: randomUUID(), startedAt: daemonStartedAt },
      durable: hydrateDurable(
        topicRows,
        repositoryRows,
        operationRows,
        configuration,
        daemonStartedAt,
      ),
      observed: {
        topics: [],
        pullRequests: [],
        diagnostics: [],
        activeActions: [],
        policies: projectSensitivePolicies(configuration, topicRows),
      },
    });
    const processes = makeProcessExecutor();
    const concurrency = makeKeyedConcurrency();
    const git = makeGitControl(processes);
    const github = makeGitHubPullRequests(
      processes,
      process.env["PI_WORK_GH_EXECUTABLE"] === undefined
        ? {}
        : { ghExecutable: process.env["PI_WORK_GH_EXECUTABLE"] },
    );
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runScoped = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner | Scope.Scope>,
    ): Effect.Effect<A, E> =>
      Effect.scoped(
        effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      );
    const rawDesktop = makeDesktopControl(processes, fs, {
      processCwd: AbsolutePath.make(paths.root),
      runtimeDirectory: AbsolutePath.make(lease.runtimeDirectory),
      ...(process.env["PI_WORK_NODE_EXECUTABLE"] === undefined
        ? {}
        : { nodeExecutable: process.env["PI_WORK_NODE_EXECUTABLE"] }),
      ...(process.env["PI_WORK_PI_EXECUTABLE"] === undefined
        ? {}
        : { piExecutable: process.env["PI_WORK_PI_EXECUTABLE"] }),
      ...(process.env["PI_WORK_SHELL"] === undefined
        ? {}
        : { shellExecutable: process.env["PI_WORK_SHELL"] }),
    });
    const desktop = {
      accessWorkspace: (topicId: TopicId) => runScoped(rawDesktop.accessWorkspace(topicId)),
      rearrangeWorkspaces: () => runScoped(rawDesktop.rearrangeWorkspaces()),
      topicWorkspace: (topicId: TopicId) => runScoped(rawDesktop.topicWorkspace(topicId)),
      hasMainAgentWindow: (topicId: TopicId) => runScoped(rawDesktop.hasMainAgentWindow(topicId)),
      openTerminal: (topicId: TopicId, path: AbsolutePath) =>
        runScoped(rawDesktop.openTerminal(topicId, path)),
      openMainAgent: (launch: Parameters<typeof rawDesktop.openMainAgent>[0]) =>
        runScoped(rawDesktop.openMainAgent(launch)),
      closeMainAgent: (topicId: TopicId) => runScoped(rawDesktop.closeMainAgent(topicId)),
      openBrowser: (url: string) => runScoped(rawDesktop.openBrowser(url)),
    };
    const provisioningControl = yield* makeTopicProvisioningControl.pipe(
      Effect.provideService(ProcessExecutor, processes),
    );
    let commands: ReturnType<typeof makeTopicCommands> | undefined;
    const activatePendingChild = (topicId: TopicId) =>
      Effect.suspend(() =>
        commands === undefined
          ? Effect.fail(
              new DomainFailure({
                reason: "invalid-relationship",
                message: "Topic chain activation is unavailable.",
                details: { topicId },
              }),
            )
          : commands
              .execute({
                clientId: ClientId.make(randomUUID()),
                requestId: RequestId.make(randomUUID()),
                command: { _tag: "ActivatePendingChild", topicId },
              })
              .pipe(Effect.asVoid),
      );
    const worker = makeProvisioningWorker({
      topics,
      operations: operationRepository,
      state,
      concurrency,
      control: provisioningControl,
      runSetupCommand: (request) =>
        runScoped(
          processes.run({
            command: { _tag: "RepositoryRecipe", shell: request.shell, command: request.command },
            cwd: request.cwd,
            timeoutMs: request.timeoutMs,
            maxOutputBytes: request.maxOutputBytes,
          }),
        ),
      activatePendingChild,
    });
    const mainAgents = yield* makeMainAgentLifecycle({
      topics,
      capabilities: operationRepository,
      state,
      desktop,
      socketPath: AbsolutePath.make(lease.socketPath),
    });
    const terminalWorker: OperationWorker = {
      resumable: false,
      run: ({ operation }) =>
        Effect.gen(function* () {
          if (operation.topicId === undefined)
            return failedOperation("topic-required", "No Topic was selected.");
          const { topic } = yield* topics.get(operation.topicId);
          if (topic.worktreePath === null)
            return failedOperation("worktree-unavailable", "The Topic Worktree is unavailable.");
          const result = yield* desktop.openTerminal(topic.id, topic.worktreePath);
          return result.kind === "unavailable"
            ? failedOperation("desktop-unavailable", result.message)
            : succeededOperation(result.message);
        }),
    };
    const mainAgentWorker = (action: "agent.open" | "agent.reset"): OperationWorker => ({
      resumable: false,
      run: ({ operation }) =>
        Effect.gen(function* () {
          if (operation.topicId === undefined)
            return failedOperation("topic-required", "No Topic was selected.");
          const result =
            action === "agent.open"
              ? yield* mainAgents.open(operation.topicId)
              : yield* mainAgents.reset(operation.topicId);
          return result.kind === "unavailable"
            ? failedOperation("desktop-unavailable", result.message)
            : succeededOperation(result.message);
        }),
    });
    const deleteWorker: OperationWorker = {
      resumable: false,
      run: ({ operation }) => {
        const value = operation.input.value;
        if (
          typeof value !== "object" ||
          value === null ||
          !("topicId" in value) ||
          typeof value.topicId !== "string"
        )
          return Effect.succeed(failedOperation("topic-required", "No Topic was selected."));
        const topicId = Schema.decodeUnknownSync(TopicId)(value.topicId);
        if (commands === undefined)
          return Effect.succeed(
            failedOperation("command-unavailable", "Topic deletion is unavailable."),
          );
        return commands.execute({
          clientId: operation.clientId,
          requestId: operation.requestId,
          command: { _tag: "Delete", topicId },
        });
      },
    };
    const operations = yield* makeOperationEngine({
      repository: operationRepository,
      state,
      workers: {
        "topic.provision": worker,
        "terminal.open": terminalWorker,
        "agent.open": mainAgentWorker("agent.open"),
        "agent.reset": mainAgentWorker("agent.reset"),
        "topic.delete": deleteWorker,
      },
    });
    const provisioning = makeProvisioningService(operations);
    const sensitiveActions = new Set<string>([
      "terminal.open",
      "agent.open",
      "agent.reset",
      "topic.delete",
    ]);
    const productionOperations = {
      ...operations,
      start: (request: Parameters<typeof operations.start>[0]) => {
        if (request.input.kind === "topic.provision")
          return provisioning.start({
            clientId: request.clientId,
            requestId: request.requestId,
            fingerprint: request.fingerprint,
            value: Schema.decodeUnknownSync(ProvisionOperationValue)(request.input.value),
            ...(request.phase === undefined ? {} : { phase: request.phase }),
          });
        if (!sensitiveActions.has(request.input.kind)) return operations.start(request);
        return Effect.gen(function* () {
          if (request.topicId === undefined)
            return yield* Effect.fail(
              new PolicyFailure({ reason: "denied", message: "No Topic was selected." }),
            );
          const action = request.input.kind as SensitiveActionKind;
          const operationRequest =
            action === "topic.delete"
              ? {
                  clientId: request.clientId,
                  requestId: request.requestId,
                  fingerprint: request.fingerprint,
                  input: { ...request.input, value: { topicId: request.topicId } },
                  ...(request.phase === undefined ? {} : { phase: request.phase }),
                }
              : request;
          const currentConfiguration = yield* configurationService.loadForPolicyCommand;
          const currentTopics = yield* topics.list;
          yield* state.publish({
            _tag: "ObservedChanged",
            policies: projectSensitivePolicies(currentConfiguration, currentTopics),
          });
          const row = currentTopics.find(({ topic }) => topic.id === request.topicId);
          if (row === undefined) {
            if (action === "topic.delete") return yield* operations.start(operationRequest);
            return yield* Effect.fail(
              new PolicyFailure({ reason: "denied", message: "The Topic does not exist." }),
            );
          }
          const decision = resolveActionPolicy(asWorkPolicies(currentConfiguration), action, {
            topicId: row.topic.id,
            repository: row.topic.repository,
          }).policy;
          if (decision === "deny")
            return yield* Effect.fail(
              new PolicyFailure({
                reason: "denied",
                message: `${sensitiveActionName(action)} is denied by the configured Action policy.`,
              }),
            );
          return yield* operations.start(
            decision === "ask"
              ? {
                  ...operationRequest,
                  confirmation: { action, lifetimeMs: 60_000, durable: true },
                }
              : operationRequest,
          );
        });
      },
    };
    let refreshAfterIntegrationBranchReset: Effect.Effect<void, never> = Effect.void;
    const repositoryPath = (repository: Repository) => repositoryPathFor(configuration, repository);
    commands = makeTopicCommands({
      topics,
      operations,
      state,
      concurrency,
      ancestry: {
        readStable: ({ repositoryPath: path, integrationBranch, topics: rows }) =>
          runScoped(makeAncestryLookup(git, path, integrationBranch, rows)),
      },
      integrationBranches: {
        configured: (repository) =>
          configurationService.refresh.pipe(
            Effect.map((current) => current.repositories[repository]?.integrationBranch),
          ),
        infer: (_repository, path) =>
          runScoped(git.listWorktrees(path)).pipe(
            Effect.map(
              (worktrees) =>
                worktrees.find((worktree) => worktree.path === path && !worktree.detached)?.branch,
            ),
          ),
      },
      repositoryPath,
      refreshAfterIntegrationBranchReset: Effect.suspend(() => refreshAfterIntegrationBranchReset),
    });
    const productionCommands = {
      ...commands,
      execute: (request: Parameters<typeof commands.execute>[0]) =>
        request.command._tag === "Delete"
          ? Effect.fail(
              new PolicyFailure({
                reason: "denied",
                message: "Delete Topic must use the policy-aware operation path.",
              }),
            )
          : commands.execute(request),
    };
    const observations = yield* makeObservationWorkers({
      state,
      git,
      github,
      concurrency,
      repositoryPath,
      integrationBranch: commands.effectiveIntegrationBranch,
      workspace: (topicId) =>
        desktop.topicWorkspace(topicId).pipe(Effect.catch(() => Effect.succeed(undefined))),
      associatePullRequest: (topicId, number, observedAt) =>
        topics.associatePullRequest(topicId, number, observedAt).pipe(
          Effect.flatMap((value) =>
            state.publish({
              _tag: "DurableCommitted",
              topics: {
                upsert: [{ topic: value.topic, rowRevision: value.revision }],
              },
            }),
          ),
          Effect.asVoid,
        ),
      dissociatePullRequest: (topicId, number, observedAt) =>
        topics.dissociatePullRequest(topicId, number, observedAt).pipe(
          Effect.flatMap((value) =>
            state.publish({
              _tag: "DurableCommitted",
              topics: {
                upsert: [{ topic: value.topic, rowRevision: value.revision }],
              },
            }),
          ),
          Effect.asVoid,
        ),
    });
    refreshAfterIntegrationBranchReset = runScoped(observations.refreshIntegration).pipe(
      Effect.catch(() => Effect.void),
    );
    yield* operations.recover;
    const recoverableChildren = (yield* topics.list).filter(
      ({ topic }) => topic.chainState === "pending" && topic.setup.state === "ready",
    );
    yield* Effect.forEach(
      recoverableChildren,
      ({ topic }) => activatePendingChild(topic.id).pipe(Effect.catch(() => Effect.void)),
      { concurrency: 1, discard: true },
    );
    yield* observations.start;

    return {
      compatibility: Effect.succeed({
        applicationProtocol: WORK_PROTOCOL_VERSION,
        storageSchema: WORK_STORAGE_SCHEMA_VERSION,
        buildId: process.env["PI_WORK_BUILD_ID"] ?? "local",
        startId: randomUUID(),
        state: "ready" as const,
      }),
      state,
      operations: productionOperations,
      commands: productionCommands,
      mainAgentCall: (request) => mainAgentCall(mainAgents, request as MainAgentCallRequest),
      ephemeralAction: ({ action, topicId }) => {
        const actionEffect = (() => {
          switch (action) {
            case "refresh":
              return observations.refresh;
            case "refresh-local":
              return observations.refreshLocal;
            case "refresh-integration":
              return observations.refreshIntegration;
            case "refresh-pull-requests":
              return observations.refreshPullRequests;
            case "rearrange":
              return desktop.rearrangeWorkspaces();
            case "rebase":
              return topicId === undefined ? Effect.void : observations.rebase(topicId);
            case "workspace":
              return topicId === undefined
                ? Effect.succeed({ kind: "unavailable", message: "No Topic was selected." })
                : desktop.accessWorkspace(topicId);
            case "terminal":
              return Effect.succeed({
                kind: "unavailable",
                message: "Open Terminal must use the policy-aware operation path.",
              });
            case "pull-request":
              return topicId === undefined
                ? Effect.succeed({ kind: "unavailable", message: "No Topic was selected." })
                : state.snapshot.pipe(
                    Effect.flatMap((snapshot) => {
                      const topic = snapshot.durable.topics.find(
                        (entry) => entry.topic.id === topicId,
                      )?.topic;
                      const pullRequest = snapshot.observed.pullRequests.find(
                        (entry) => entry.topicId === topicId,
                      )?.value;
                      const number = pullRequest?.identity.number ?? topic?.pullRequest?.number;
                      if (number === undefined)
                        return Effect.succeed({
                          kind: "unavailable" as const,
                          message: "The Topic has no pull request.",
                        });
                      const url =
                        pullRequest?.url ??
                        `https://github.com/${topic!.repository}/pull/${number}`;
                      return desktop.openBrowser(url);
                    }),
                  );
          }
        })();
        return runScoped(actionEffect);
      },
    };
  });
}

function asWorkPolicies(configuration: WorkConfiguration): WorkPolicies {
  // The configuration schema uses branded record keys. Policy lookup treats them as strings.
  return configuration.policies as unknown as WorkPolicies;
}

function projectSensitivePolicies(
  configuration: WorkConfiguration,
  topics: ReadonlyArray<{ readonly topic: DurableTopic }>,
): Policy[] {
  const policies = asWorkPolicies(configuration);
  const actions = [
    "topic.run-setup",
    "terminal.open",
    "agent.open",
    "agent.reset",
    "topic.delete",
  ] as const;
  return topics.flatMap(({ topic }) =>
    actions.map((action) => ({
      action,
      decision: resolveActionPolicy(policies, action, {
        topicId: topic.id,
        repository: topic.repository,
      }).policy,
      scope: { kind: "topic" as const, topicId: topic.id },
    })),
  );
}

type SensitiveActionKind = "terminal.open" | "agent.open" | "agent.reset" | "topic.delete";

function sensitiveActionName(action: SensitiveActionKind): string {
  if (action === "terminal.open") return "Open Terminal";
  if (action === "agent.open") return "Open Main Agent";
  if (action === "agent.reset") return "Start New Main Agent";
  return "Delete Topic";
}

function succeededOperation(message: string): DurableOperationResult {
  return { version: 1, status: "succeeded", value: { message } };
}

function failedOperation(reason: string, message: string): DurableOperationResult {
  return { version: 1, status: "failed", value: { reason, message } };
}

function hydrateDurable(
  topics: ReadonlyArray<{ readonly topic: DurableTopic; readonly revision: number }>,
  repositoryStates: ReadonlyArray<RevisionedRepositoryState>,
  operations: ReadonlyArray<DurableOperation>,
  configuration: WorkConfiguration,
  projectedAt: string,
): WorkDurableProjection {
  const configuredStates = Object.entries(configuration.repositories).flatMap(
    ([repository, recipe]) =>
      recipe.integrationBranch === undefined
        ? []
        : [
            {
              repository: repository as Repository,
              integrationBranch: recipe.integrationBranch,
              source: "configured" as const,
              rowRevision: 0,
              updatedAt: projectedAt,
            },
          ],
  );
  const inferredStates = repositoryStates
    .filter((row) => configuration.repositories[row.repository]?.integrationBranch === undefined)
    .map((row) => ({
      repository: row.repository,
      integrationBranch: row.inferredIntegrationBranch,
      source: "inferred" as const,
      inferredIntegrationBranch: row.inferredIntegrationBranch,
      rowRevision: row.revision,
      updatedAt: row.updatedAt,
    }));
  return {
    topics: topics.map((row) => ({ topic: row.topic, rowRevision: row.revision })),
    repositoryStates: [...configuredStates, ...inferredStates].toSorted((left, right) =>
      left.repository.localeCompare(right.repository),
    ),
    operations: boundProjectedOperations(
      operations.map((operation) => ({
        id: operation.id,
        ...(operation.topicId === undefined ? {} : { topicId: operation.topicId }),
        state: operation.state,
        phase: operation.phase,
        input: operation.input,
        ...(operation.result === undefined ? {} : { result: operation.result }),
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
        ...(operation.terminalAt === undefined ? {} : { terminalAt: operation.terminalAt }),
        rowRevision: operation.revision,
      })),
    ),
  };
}

function repositoryPathFor(configuration: WorkConfiguration, repository: Repository): AbsolutePath {
  const configured = configuration.repositories[repository]?.basePath;
  if (configured !== undefined) return configured;
  if (configuration.workBase === undefined) return AbsolutePath.make("/");
  return AbsolutePath.make(join(configuration.workBase, basename(repository)));
}

function mainAgentCall(lifecycle: MainAgentLifecycle<never>, request: MainAgentCallRequest) {
  switch (request.action) {
    case "open":
    case "reset":
      return Effect.fail(
        new PolicyFailure({
          reason: "denied",
          message: `${sensitiveActionName(
            request.action === "open" ? "agent.open" : "agent.reset",
          )} must use the policy-aware operation path.`,
        }),
      );
    case "register":
      return lifecycle.register({
        connectionId: request.connectionId,
        topicId: request.topicId,
        sessionId: request.sessionId,
        sessionFile: request.sessionFile,
        registration: Redacted.make(request.capability) as PrivateLocalCapability,
      });
    case "adopt":
      return lifecycle.adopt({
        connectionId: request.connectionId,
        topicId: request.topicId,
        sessionId: request.sessionId,
        sessionFile: request.sessionFile,
        affiliation: Redacted.make(request.capability) as PrivateLocalCapability,
      });
    case "heartbeat":
      return lifecycle.heartbeat(request.connectionId);
    case "report":
      return lifecycle.report(request.connectionId, request.activity as never);
    case "disconnected":
      return lifecycle.disconnected(request.connectionId);
  }
}

function makeAncestryLookup(
  git: ReturnType<typeof makeGitControl>,
  repositoryPath: AbsolutePath,
  integrationBranch: Branch,
  topics: ReadonlyArray<{ readonly topic: { readonly id: TopicId; readonly branch: Branch } }>,
): Effect.Effect<AncestryLookup, any, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> {
  const branchFor = (node: ChainNode): Branch | undefined =>
    node.kind === "integration-branch"
      ? integrationBranch
      : topics.find((row) => row.topic.id === node.topicId)?.topic.branch;
  const nodes: ReadonlyArray<ChainNode> = [
    { kind: "integration-branch" },
    ...topics.map((row) => ({ kind: "topic" as const, topicId: row.topic.id })),
  ];
  return Effect.gen(function* () {
    const results = new Map<string, boolean>();
    for (const ancestor of nodes) {
      for (const descendant of nodes) {
        const left = branchFor(ancestor);
        const right = branchFor(descendant);
        if (left === undefined || right === undefined) continue;
        results.set(
          `${JSON.stringify(ancestor)}:${JSON.stringify(descendant)}`,
          yield* git.contains(repositoryPath, { branch: left }, { branch: right }),
        );
      }
    }
    return (ancestor, descendant) =>
      results.get(`${JSON.stringify(ancestor)}:${JSON.stringify(descendant)}`);
  });
}
