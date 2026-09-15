import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  AbsolutePath,
  Branch,
  ClientId,
  FullCommitSha,
  Repository,
  RequestId,
  TopicId,
  decodeAbsolutePath,
  decodeBranch,
  decodeRepository,
  decodeTopicId,
  ActionId,
  type DurableTopic,
} from "../domain/index.ts";
import {
  WorkConfiguration,
  type WorkConfiguration as WorkConfigurationValue,
} from "../infrastructure/config.ts";
import { makeGitControl } from "../infrastructure/git/index.ts";
import { makeProcessExecutor, ProcessPlatformLive } from "../infrastructure/process/index.ts";
import type { StartOperationRequest } from "../infrastructure/rpc/index.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";
import type { WorkSnapshot } from "../application/state/index.ts";

export interface EffectTopicCreateInput {
  readonly name: string;
  readonly repository?: string;
  readonly branch?: string;
  readonly startPoint?: string;
  readonly sourceCheckout?: string;
}

export interface EffectChildTopicCreateInput {
  readonly name: string;
  readonly parentTopicId: string;
  readonly branch?: string;
  readonly startPoint: string;
  readonly sourceCheckout: string;
}

export interface TopicOperationPlan {
  readonly request: StartOperationRequest;
  readonly topicId: TopicId;
  readonly repository: Repository;
  readonly branch: Branch;
}

/** Read and strictly decode the configuration used to snapshot one provisioning attempt. */
export async function loadWorkConfiguration(path: string): Promise<WorkConfigurationValue> {
  return Schema.decodeUnknownSync(WorkConfiguration)(JSON.parse(await readFile(path, "utf8")));
}

/**
 * Resolve all local Git questions through GitControl, then make the immutable input for one root
 * provisioning operation. No Git process or configuration read remains in the operation wait.
 */
export async function planRootTopicOperation(
  input: EffectTopicCreateInput,
  configuration: WorkConfigurationValue,
  clientId: ClientId,
  requestId: RequestId = RequestId.make(randomUUID()),
): Promise<TopicOperationPlan> {
  const name = topicName(input.name);
  const branch = topicBranch(name, input.branch);
  const explicitRepository = input.repository?.trim();
  const needsGit = explicitRepository === undefined || input.startPoint !== undefined;
  if (needsGit && input.sourceCheckout === undefined) {
    throw new Error("Source checkout is required to infer a repository or resolve a Start Point.");
  }
  const resolved = needsGit
    ? await resolveStartPoint(
        input.sourceCheckout!,
        input.startPoint?.trim() || "HEAD",
        explicitRepository,
      )
    : undefined;
  const repository =
    explicitRepository === undefined ? resolved!.repository : decodeRepository(explicitRepository);
  const topicId = TopicId.make(randomUUID());
  const topic = initialTopic({ topicId, name, repository, branch });
  const value = provisionValue(
    "create-root",
    topic,
    configuration,
    input.startPoint === undefined
      ? undefined
      : { commit: resolved!.commit, sourceCheckout: resolved!.sourceCheckout },
  );
  return operationPlan(clientId, requestId, topic, value);
}

/** Resolve and validate a child Start Point against its Parent Branch before operation start. */
export async function planChildTopicOperation(
  input: EffectChildTopicCreateInput,
  snapshot: WorkSnapshot,
  configuration: WorkConfigurationValue,
  clientId: ClientId,
  requestId: RequestId = RequestId.make(randomUUID()),
): Promise<TopicOperationPlan> {
  const parentId = decodeTopicId(input.parentTopicId);
  const parent = snapshot.durable.topics.find(({ topic }) => topic.id === parentId)?.topic;
  if (parent === undefined) throw new Error("The Parent Topic does not exist.");
  const name = topicName(input.name);
  const branch = topicBranch(name, input.branch);
  const resolved = await resolveStartPoint(
    input.sourceCheckout,
    input.startPoint.trim(),
    parent.repository,
    parent.branch,
  );
  const topicId = TopicId.make(randomUUID());
  const topic: DurableTopic = {
    ...initialTopic({ topicId, name, repository: parent.repository, branch }),
    partition: parent.partition,
    parentTopicId: parent.id,
    originCommit: resolved.commit,
    integrationTarget: parent.integrationTarget ?? { kind: "integration-branch" },
    chainState: "pending",
  };
  const value = provisionValue("create-child", topic, configuration, {
    commit: resolved.commit,
    sourceCheckout: resolved.sourceCheckout,
  });
  return operationPlan(clientId, requestId, topic, value);
}

/** Make one immutable retry request without changing the stored Topic identity or family. */
export function planRetryTopicOperation(
  topicId: TopicId,
  snapshot: WorkSnapshot,
  configuration: WorkConfigurationValue,
  clientId: ClientId,
  requestId: RequestId = RequestId.make(randomUUID()),
): TopicOperationPlan {
  const topic = snapshot.durable.topics.find((row) => row.topic.id === topicId)?.topic;
  if (topic === undefined) throw new Error("The Topic does not exist.");
  if (topic.setup.state !== "setup-failed" && topic.setup.state !== "setup-interrupted") {
    throw new Error("Retry Setup is available only after Setup failed or was interrupted.");
  }
  if (topic.worktreePath === null) {
    throw new Error("Retry Setup requires the existing Topic Worktree.");
  }
  return operationPlan(clientId, requestId, topic, provisionValue("retry", topic, configuration));
}

async function resolveStartPoint(
  sourceCheckout: string,
  revision: string,
  expectedRepository?: string,
  parentBranch?: Branch,
): Promise<{ repository: Repository; commit: FullCommitSha; sourceCheckout: AbsolutePath }> {
  if (revision.length === 0) throw new Error("Start Point must not be empty.");
  const path = decodeAbsolutePath(resolve(sourceCheckout));
  const git = makeGitControl(makeProcessExecutor());
  return Effect.runPromise(
    Effect.scoped(
      git
        .resolveStartPoint({
          sourceCheckout: path,
          revision,
          ...(expectedRepository === undefined
            ? {}
            : { expectedRepository: decodeRepository(expectedRepository) }),
        })
        .pipe(
          Effect.flatMap((resolved) => {
            if (parentBranch === undefined) return Effect.succeed(resolved);
            return git
              .contains(
                resolved.repositoryRoot,
                { commit: resolved.startPoint.commit },
                { branch: parentBranch },
              )
              .pipe(
                Effect.flatMap((contained) =>
                  contained
                    ? Effect.succeed(resolved)
                    : Effect.fail(
                        new Error("Start Point is not a commit of the Parent Topic Branch."),
                      ),
                ),
              );
          }),
          Effect.map((resolved) => ({
            repository: resolved.repository,
            commit: resolved.startPoint.commit,
            sourceCheckout: resolved.startPoint.sourceCheckout,
          })),
        ),
    ).pipe(Effect.provide(ProcessPlatformLive)),
  );
}

function topicName(value: string): string {
  const name = value.trim();
  if (name.length === 0 || name.length > 200)
    throw new Error("Topic name must contain 1 through 200 characters.");
  return name;
}

function topicBranch(name: string, value?: string): Branch {
  return decodeBranch(
    value === undefined || value.trim().length === 0 ? defaultBranchForTopicName(name) : value,
  );
}

function initialTopic(input: {
  topicId: TopicId;
  name: string;
  repository: Repository;
  branch: Branch;
}): DurableTopic {
  const now = new Date().toISOString();
  return {
    id: input.topicId,
    name: input.name,
    repository: input.repository,
    branch: input.branch,
    setup: {
      state: "provisioning",
      repositoryAvailable: false,
      worktreeCreated: false,
      setupCommandsRun: false,
      completedCommandCount: 0,
    },
    worktreePath: null,
    mainAgent: { sessionId: randomUUID(), sessionFile: null },
    partition: 0,
    integrationTarget: { kind: "integration-branch" },
    createdAt: now,
    updatedAt: now,
  };
}

function provisionValue(
  attempt: "create-root" | "create-child" | "retry",
  topic: DurableTopic,
  configuration: WorkConfigurationValue,
  startPoint?: { readonly commit: FullCommitSha; readonly sourceCheckout: AbsolutePath },
) {
  if (configuration.workBase === undefined) throw new Error("WORK_BASE is not configured.");
  const recipe = configuration.repositories[topic.repository] ?? { setupCommands: [] };
  const repositoryPolicies = configuration.policies.repositories[topic.repository] ?? {};
  const topicPolicies = configuration.policies.topics[topic.id] ?? {};
  const actions: ReadonlyArray<typeof ActionId.Type> = [
    "repository.clone",
    "topic.create-worktree",
    "topic.run-setup",
    "terminal.open",
    "agent.open",
    "agent.reset",
    "topic.delete",
  ];
  const policies = Object.fromEntries(
    actions.map((action) => [
      action,
      topicPolicies[action] ??
        repositoryPolicies[action] ??
        configuration.policies.defaults[action],
    ]),
  );
  return {
    attempt,
    topic,
    workBase: configuration.workBase,
    recipe,
    policies,
    ...(startPoint === undefined ? {} : { startPoint }),
  };
}

function operationPlan(
  _clientId: ClientId,
  requestId: RequestId,
  topic: DurableTopic,
  value: ReturnType<typeof provisionValue>,
): TopicOperationPlan {
  const input = { version: 1 as const, kind: "topic.provision", value };
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  return {
    topicId: topic.id,
    repository: topic.repository,
    branch: topic.branch,
    request: { requestId, fingerprint, input, topicId: topic.id, phase: "accepted" },
  };
}
