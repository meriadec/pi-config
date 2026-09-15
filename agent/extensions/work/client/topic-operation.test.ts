import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AbsolutePath,
  Branch,
  ClientId,
  Repository,
  RequestId,
  TopicId,
  type DurableTopic,
} from "../domain/index.ts";
import { ProvisionOperationValue } from "../application/provisioning/index.ts";
import type { WorkSnapshot } from "../application/state/index.ts";
import type { WorkConfiguration } from "../infrastructure/config.ts";
import { TopicRepository, topicRepositoryLayer } from "../infrastructure/storage/index.ts";
import {
  createParentBranchScenario,
  createTemporaryRoot,
  removeTemporaryRoots,
} from "../test-support/git-repository.ts";
import {
  planChildTopicOperation,
  planRetryTopicOperation,
  planRootTopicOperation,
} from "./topic-operation.ts";

const clientId = ClientId.make("10000000-0000-4000-8000-000000000001");
const parentId = TopicId.make("10000000-0000-4000-8000-000000000002");
const roots: string[] = [];
const configuration: WorkConfiguration = {
  version: 2,
  workBase: AbsolutePath.make("/work"),
  policies: {
    defaults: {
      "repository.clone": "ask",
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
  repositories: {},
};

afterEach(async () => removeTemporaryRoots(roots));

function snapshot(parent: DurableTopic): WorkSnapshot {
  return {
    daemon: { id: "daemon", startedAt: "2026-01-01T00:00:00.000Z" },
    revision: 0,
    durable: { topics: [{ rowRevision: 0, topic: parent }], repositoryStates: [], operations: [] },
    observed: { topics: [], pullRequests: [], diagnostics: [], activeActions: [] },
  };
}

describe("Effect Topic operation planning", () => {
  test("an explicit repository without a Start Point does not inspect a Source checkout", async () => {
    const plan = await planRootTopicOperation(
      { name: "Explicit topic", repository: "acme/widgets" },
      configuration,
      clientId,
      RequestId.make("20000000-0000-4000-8000-000000000001"),
    );
    expect(String(plan.repository)).toBe("acme/widgets");
    expect(String(plan.branch)).toBe("explicit-topic");
    expect(String(plan.request.requestId)).toBe("20000000-0000-4000-8000-000000000001");
    expect(plan.request.input.kind).toBe("topic.provision");
    expect(plan.request.input.value).toMatchObject({
      attempt: "create-root",
      workBase: "/work",
      recipe: { setupCommands: [] },
    });
  });

  test("gives a configured root Topic an Integration Target before storage", async () => {
    const root = await createTemporaryRoot("pi-work-root-plan-");
    roots.push(root);
    const repository = Repository.make("LedgerHQ/revault");
    const configured: WorkConfiguration = {
      ...configuration,
      repositories: {
        [repository]: {
          integrationBranch: Branch.make("main"),
          setupCommands: ["pnpm install"],
        },
      },
    };
    const plan = await planRootTopicOperation(
      {
        name: "VG-32135 - Retry request approval",
        repository: "LedgerHQ/revault",
        branch: "VG-32135-retry-request-approval",
      },
      configured,
      clientId,
      RequestId.make("20000000-0000-4000-8000-000000000004"),
    );
    expect(plan.request.input.kind).toBe("topic.provision");
    const value = Schema.decodeUnknownSync(ProvisionOperationValue)(plan.request.input.value);

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const topics = yield* TopicRepository;
          return yield* topics.create(value.topic);
        }).pipe(
          Effect.scoped,
          Effect.provide(topicRepositoryLayer({ filename: join(root, "work.db") })),
        ),
      ),
    ).resolves.toMatchObject({
      topic: { integrationTarget: { kind: "integration-branch" } },
    });
  });

  test("resolves one child commit on the Parent Branch and preserves family semantics", async () => {
    const root = await createTemporaryRoot("pi-work-child-plan-");
    roots.push(root);
    const scenario = await createParentBranchScenario(root, { checkpointCount: 2 });
    await scenario.repository.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    await scenario.repository.checkout(scenario.parentBranch);
    const parent: DurableTopic = {
      id: parentId,
      name: "Parent",
      repository: "acme/widgets" as DurableTopic["repository"],
      branch: scenario.parentBranch as DurableTopic["branch"],
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
        completedCommandCount: 0,
      },
      worktreePath: AbsolutePath.make(scenario.repository.path),
      mainAgent: { sessionId: "session", sessionFile: null },
      partition: 3,
      integrationTarget: { kind: "integration-branch" },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const plan = await planChildTopicOperation(
      {
        name: "Child Work",
        parentTopicId: parentId,
        startPoint: scenario.checkpoints[0]!,
        sourceCheckout: scenario.repository.path,
      },
      snapshot(parent),
      configuration,
      clientId,
      RequestId.make("20000000-0000-4000-8000-000000000002"),
    );

    expect(plan.request.input.value).toMatchObject({
      attempt: "create-child",
      topic: {
        name: "Child Work",
        branch: "child-work",
        parentTopicId: parentId,
        partition: 3,
        originCommit: scenario.checkpoints[0],
        chainState: "pending",
        integrationTarget: { kind: "integration-branch" },
      },
      startPoint: { commit: scenario.checkpoints[0], sourceCheckout: scenario.repository.path },
    });
  });

  test("rejects a Start Point that is not on the Parent Branch", async () => {
    const root = await createTemporaryRoot("pi-work-child-plan-");
    roots.push(root);
    const scenario = await createParentBranchScenario(root, { checkpointCount: 1 });
    await scenario.repository.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    const outside = await scenario.repository.commit("outside.txt", "outside");
    const parent = {
      id: parentId,
      name: "Parent",
      repository: "acme/widgets",
      branch: scenario.parentBranch,
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
        completedCommandCount: 0,
      },
      worktreePath: scenario.repository.path,
      mainAgent: { sessionId: "session", sessionFile: null },
      partition: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as DurableTopic;

    expect(
      planChildTopicOperation(
        {
          name: "Child",
          parentTopicId: parentId,
          startPoint: outside,
          sourceCheckout: scenario.repository.path,
        },
        snapshot(parent),
        configuration,
        clientId,
      ),
    ).rejects.toThrow("Start Point is not a commit of the Parent Topic Branch.");
  });

  test("plans one stable retry with the exact stored Topic identity", () => {
    const failed: DurableTopic = {
      id: parentId,
      name: "Failed child",
      repository: "acme/widgets" as DurableTopic["repository"],
      branch: "feature/failed" as DurableTopic["branch"],
      setup: {
        state: "setup-interrupted",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: false,
        completedCommandCount: 1,
      },
      worktreePath: AbsolutePath.make("/work/failed"),
      mainAgent: { sessionId: "same-session", sessionFile: null },
      partition: 7,
      parentTopicId: TopicId.make("10000000-0000-4000-8000-000000000003"),
      chainState: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const requestId = RequestId.make("20000000-0000-4000-8000-000000000003");
    const plan = planRetryTopicOperation(
      parentId,
      snapshot(failed),
      {
        ...configuration,
        repositories: {
          [failed.repository]: { setupCommands: ["first", "second"] },
        },
      },
      clientId,
      requestId,
    );
    expect(plan.request.requestId).toBe(requestId);
    expect(plan.request.input.value).toMatchObject({
      attempt: "retry",
      topic: failed,
      recipe: { setupCommands: ["first", "second"] },
    });
    expect(plan.request.fingerprint).toBeString();
  });
});
