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
  PrivateLocalCapability,
  WORK_PROTOCOL_VERSION,
  WORK_STORAGE_SCHEMA_VERSION,
  type Branch,
  type Repository,
  type DurableTopic,
  type TopicId,
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
import { makeOperationEngine, type DurableOperation } from "../application/operation/index.ts";
import {
  makeProvisioningService,
  makeProvisioningWorker,
  ProvisionOperationValue,
} from "../application/provisioning/index.ts";
import { makeWorkState, type WorkDurableProjection } from "../application/state/index.ts";
import type { WorkPaths } from "../shared/paths.ts";
import type { AncestryLookup, ChainNode } from "../shared/integration-chain.ts";

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
    const state = yield* makeWorkState({
      daemon: { id: randomUUID(), startedAt: new Date().toISOString() },
      durable: hydrateDurable(topicRows, repositoryRows, operationRows),
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
    });
    const operations = yield* makeOperationEngine({
      repository: operationRepository,
      state,
      workers: { "topic.provision": worker },
    });
    const provisioning = makeProvisioningService(operations);
    const productionOperations = {
      ...operations,
      start: (request: Parameters<typeof operations.start>[0]) =>
        request.input.kind !== "topic.provision"
          ? operations.start(request)
          : provisioning.start({
              clientId: request.clientId,
              requestId: request.requestId,
              fingerprint: request.fingerprint,
              value: Schema.decodeUnknownSync(ProvisionOperationValue)(request.input.value),
              ...(request.phase === undefined ? {} : { phase: request.phase }),
            }),
    };
    const repositoryPath = (repository: Repository) => repositoryPathFor(configuration, repository);
    const commands = makeTopicCommands({
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
          Effect.succeed(configuration.repositories[repository]?.integrationBranch),
        infer: () => Effect.succeed(undefined),
      },
      repositoryPath,
    });
    const mainAgents = yield* makeMainAgentLifecycle({
      topics,
      capabilities: operationRepository,
      state,
      desktop,
      socketPath: AbsolutePath.make(lease.socketPath),
    });
    const observations = yield* makeObservationWorkers({
      state,
      git,
      github,
      concurrency,
      repositoryPath,
      integrationBranch: commands.effectiveIntegrationBranch,
    });
    yield* operations.recover;
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
      commands,
      mainAgentCall: (request) => mainAgentCall(mainAgents, request as MainAgentCallRequest),
      ephemeralAction: ({ action, topicId }) => {
        const actionEffect = (() => {
          switch (action) {
            case "refresh":
              return observations.refresh;
            case "refresh-local":
              return observations.refreshLocal;
            case "refresh-pull-requests":
              return observations.refreshPullRequests;
            case "rebase":
              return topicId === undefined ? Effect.void : observations.rebase(topicId);
            case "workspace":
              return topicId === undefined
                ? Effect.succeed({ kind: "unavailable", message: "No Topic was selected." })
                : desktop.accessWorkspace(topicId);
            case "terminal":
              return topicId === undefined
                ? Effect.succeed({ kind: "unavailable", message: "No Topic was selected." })
                : topics.get(topicId).pipe(
                    Effect.flatMap(({ topic }) =>
                      topic.worktreePath === null
                        ? Effect.succeed({
                            kind: "unavailable",
                            message: "The Topic Worktree is unavailable.",
                          })
                        : desktop.openTerminal(topicId, topic.worktreePath),
                    ),
                  );
            case "pull-request":
              return topicId === undefined
                ? Effect.succeed({ kind: "unavailable", message: "No Topic was selected." })
                : state.snapshot.pipe(
                    Effect.flatMap((snapshot) => {
                      const pullRequest = snapshot.observed.pullRequests.find(
                        (entry) => entry.topicId === topicId,
                      )?.value;
                      return pullRequest === undefined
                        ? Effect.succeed({
                            kind: "unavailable",
                            message: "The Topic has no observed pull request.",
                          })
                        : desktop.openBrowser(pullRequest.url);
                    }),
                  );
          }
        })();
        return runScoped(actionEffect);
      },
    };
  });
}

function hydrateDurable(
  topics: ReadonlyArray<{ readonly topic: DurableTopic; readonly revision: number }>,
  repositoryStates: ReadonlyArray<RevisionedRepositoryState>,
  operations: ReadonlyArray<DurableOperation>,
): WorkDurableProjection {
  return {
    topics: topics.map((row) => ({ topic: row.topic, rowRevision: row.revision })),
    repositoryStates: repositoryStates.map((row) => ({
      repository: row.repository,
      inferredIntegrationBranch: row.inferredIntegrationBranch,
      rowRevision: row.revision,
      updatedAt: row.updatedAt,
    })),
    operations: operations.map((operation) => ({
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
      return lifecycle.open(request.topicId);
    case "reset":
      return lifecycle.reset(request.topicId);
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
