import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  AbsolutePath,
  ClientId,
  OperationId,
  TopicId,
  type DurableTopic,
} from "../domain/index.ts";
import type { WorkSnapshot } from "../application/state/index.ts";
import type {
  DurableOperation,
  OperationHandle,
  StartOperationRequest,
} from "../infrastructure/rpc/index.ts";
import {
  createParentBranchScenario,
  createTemporaryRoot,
  removeTemporaryRoots,
} from "../test-support/git-repository.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import { registerEffectWorkTopicTools } from "./effect-tools.ts";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<unknown> | undefined,
    context: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text?: string }>; details: Record<string, unknown> }>;
}

const roots: string[] = [];
const clientId = ClientId.make("81000000-0000-4000-8000-000000000001");
const operationId = OperationId.make("81000000-0000-4000-8000-000000000002");
const parentId = TopicId.make("81000000-0000-4000-8000-000000000003");

afterEach(async () => removeTemporaryRoots(roots));

class FakeRuntime {
  readonly clientId = clientId;
  readonly requests: StartOperationRequest[] = [];
  disposed = 0;
  snapshotValue: WorkSnapshot = emptySnapshot();
  handle: OperationHandle = { id: operationId, state: "running" };
  terminal: DurableOperation = operation("succeeded", "succeeded", {
    version: 1,
    status: "succeeded",
    value: { topicId: "created", state: "ready" },
  });
  awaitOverride?: () => Promise<DurableOperation>;

  snapshot = async () => this.snapshotValue;
  startOperation = async (request: StartOperationRequest) => {
    this.requests.push(request);
    return this.handle;
  };
  getOperation = async () => this.terminal;
  awaitOperation = async () =>
    this.awaitOverride === undefined ? this.terminal : this.awaitOverride();
  watchOperation = (_id: OperationId, update: (value: DurableOperation) => void) => {
    update(operation("running", "setup 1/2"));
    return () => undefined;
  };
  dispose = async () => {
    this.disposed += 1;
  };
}

describe("Effect Work Topic tool registration", () => {
  test("registers both stable focused tools once with model guidance", () => {
    const tools: RegisteredTool[] = [];
    const api = apiFor(tools);
    registerEffectWorkTopicTools(api, { home: "/home/test", runtime: "/run/test" });
    registerEffectWorkTopicTools(api, { home: "/home/test", runtime: "/run/test" });

    expect(tools.map((tool) => tool.name)).toEqual([
      "work_topic_create",
      "work_topic_create_child",
    ]);
    expect(tools[0]!.parameters.required).toEqual(["name"]);
    expect(tools[1]!.parameters.required).toEqual(["name", "startPoint"]);
    expect(tools[1]!.parameters.properties).not.toHaveProperty("repository");
    const guidance = tools
      .flatMap((tool) => [
        tool.label,
        tool.description,
        tool.promptSnippet ?? "",
        ...(tool.promptGuidelines ?? []),
      ])
      .join(" ");
    expect(guidance).toContain("Never send blank");
    expect(guidance).toContain("git log");
    expect(guidance).toContain("original request is not approval");
    expect(guidance).toContain("does not open a Main Agent");
  });
});

describe("Effect Work Topic tool execution", () => {
  test("omits blank root options, preserves explicit identity, and ignores the tool-call ID", async () => {
    const world = await makeWorld();
    const runtime = new FakeRuntime();
    const root = registered(world, runtime)[0]!;
    const result = await root.execute(
      `call_${"x".repeat(500)}`,
      {
        name: " Explicit Topic ",
        repository: " acme/widgets ",
        branch: " Feature/Keep-Case ",
        startPoint: " ",
        sourceCheckout: " ",
      },
      undefined,
      undefined,
      context("/must-not-be-inspected"),
    );

    const request = runtime.requests[0]!;
    expect(String(request.requestId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(request.requestId)).not.toContain("call_");
    expect(request.input.value).toMatchObject({
      topic: {
        name: "Explicit Topic",
        repository: "acme/widgets",
        branch: "Feature/Keep-Case",
      },
    });
    expect(result.details).toMatchObject({
      status: "succeeded",
      repository: "acme/widgets",
      branch: "Feature/Keep-Case",
      operationId,
    });
    expect(runtime.disposed).toBe(1);
  });

  test("defaults root Source checkout and resolves a revision to one exact commit", async () => {
    const world = await makeWorld();
    const source = await createTemporaryRoot("pi-work-tool-root-");
    roots.push(source);
    const scenario = await createParentBranchScenario(source, { checkpointCount: 2 });
    await scenario.repository.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    const runtime = new FakeRuntime();
    const root = registered(world, runtime)[0]!;

    await root.execute(
      "call-root",
      { name: "From first", startPoint: scenario.checkpoints[0]! },
      undefined,
      undefined,
      context(scenario.repository.path),
    );

    expect(runtime.requests[0]!.input.value).toMatchObject({
      topic: { repository: "acme/widgets", branch: "from-first" },
      startPoint: {
        commit: scenario.checkpoints[0],
        sourceCheckout: scenario.repository.path,
      },
    });
  });

  test("defaults Parent from the Main Agent and accepts an explicit Parent outside it", async () => {
    const world = await makeWorld();
    const source = await createTemporaryRoot("pi-work-tool-child-");
    roots.push(source);
    const scenario = await createParentBranchScenario(source, { checkpointCount: 2 });
    await scenario.repository.git("remote", "add", "origin", "git@github.com:acme/widgets.git");
    const parent = parentTopic(scenario.repository.path, scenario.parentBranch);

    for (const parentTopicId of [undefined, String(parentId)]) {
      const runtime = new FakeRuntime();
      runtime.snapshotValue = snapshot(parent);
      const child = registered(world, runtime, { PI_WORK_TOPIC_ID: String(parentId) })[1]!;
      await child.execute(
        "call-child",
        {
          name: "Child Work",
          startPoint: scenario.checkpoints[0]!,
          ...(parentTopicId === undefined ? {} : { parentTopicId }),
          branch: " Feature/Child ",
        },
        undefined,
        undefined,
        context(scenario.repository.path),
      );
      expect(runtime.requests[0]!.input.value).toMatchObject({
        attempt: "create-child",
        topic: {
          parentTopicId: parentId,
          repository: "acme/widgets",
          branch: "Feature/Child",
          originCommit: scenario.checkpoints[0],
        },
      });
    }
  });

  test("returns exact headless confirmation text and never self-approves", async () => {
    const world = await makeWorld();
    const runtime = new FakeRuntime();
    runtime.handle = {
      id: operationId,
      state: "awaiting-confirmation",
      confirmation: "private",
      confirmationText: "Create this exact Worktree?",
    };
    runtime.terminal = operation("awaiting-confirmation", "awaiting-confirmation");
    let confirmed = 0;
    Object.assign(runtime, {
      confirmOperation: async () => {
        confirmed += 1;
      },
    });
    const result = await registered(world, runtime)[0]!.execute(
      "call-confirm",
      { name: "Confirm", repository: "acme/widgets" },
      undefined,
      undefined,
      context("/cwd"),
    );

    expect(result.details).toMatchObject({
      status: "confirmation-required",
      confirmationText: "Create this exact Worktree?",
      operationId,
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(confirmed).toBe(0);
  });

  test("keeps policy denial and direct rejection as distinct semantic results", async () => {
    const world = await makeWorld();
    for (const [expected, terminal] of [
      [
        "denied",
        operation("failed", "failed", {
          version: 1,
          status: "failed",
          value: { reason: "denied", message: "Policy denied repository.clone." },
        }),
      ],
      [
        "rejected",
        operation("cancelled", "rejected", {
          version: 1,
          status: "cancelled",
          value: { reason: "confirmation-rejected" },
        }),
      ],
    ] as const) {
      const runtime = new FakeRuntime();
      runtime.terminal = terminal;
      const result = await registered(world, runtime)[0]!.execute(
        `call-${expected}`,
        { name: expected, repository: "acme/widgets" },
        undefined,
        undefined,
        context("/cwd"),
      );
      expect(result.details["status"]).toBe(expected);
    }
  });

  test("client cancellation returns the accepted identity without cancelling daemon work", async () => {
    const world = await makeWorld();
    const runtime = new FakeRuntime();
    runtime.awaitOverride = () => new Promise(() => undefined);
    const controller = new AbortController();
    const execution = registered(world, runtime)[0]!.execute(
      "call-cancel",
      { name: "Cancel wait", repository: "acme/widgets" },
      controller.signal,
      undefined,
      context("/cwd"),
    );
    while (runtime.requests.length === 0) await Bun.sleep(1);
    controller.abort();
    const result = await execution;
    expect(result.details).toMatchObject({ status: "cancelled", operationId });
    expect(runtime.disposed).toBe(1);
  });

  test("bounds errors and returns the operation identity when timeout stops only waiting", async () => {
    const world = await makeWorld();
    const runtime = new FakeRuntime();
    runtime.awaitOverride = () => new Promise(() => undefined);
    const result = await registered(world, runtime)[0]!.execute(
      "call-timeout",
      { name: "Timeout", repository: "acme/widgets", timeoutSeconds: 1 },
      undefined,
      undefined,
      context("/cwd"),
    );
    expect(result.details).toMatchObject({ status: "timeout", operationId });
    expect(runtime.disposed).toBe(1);

    const broken = new FakeRuntime();
    broken.snapshot = async () => {
      throw new Error("x".repeat(5_000));
    };
    const child = registered(world, broken, { PI_WORK_TOPIC_ID: String(parentId) })[1]!;
    const failure = await child.execute(
      "call-failure",
      { name: "Broken", startPoint: "HEAD" },
      undefined,
      undefined,
      context("/cwd"),
    );
    expect(failure.details["status"]).toBe("failed");
    expect((failure.content[0]?.text ?? "").length).toBeLessThanOrEqual(1_000);
    expect(broken.disposed).toBe(1);
  }, 3_000);
});

async function makeWorld(): Promise<{ home: string; runtime: string }> {
  const root = await createTemporaryRoot("pi-work-tool-world-");
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  await mkdir(join(home, "work"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(
    join(home, "work", "config.json"),
    JSON.stringify({
      version: 2,
      workBase: "/work",
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
      repositories: {},
    }),
  );
  return { home, runtime };
}

function registered(
  world: { home: string; runtime: string },
  runtime: FakeRuntime,
  environment: Record<string, string | undefined> = {},
): RegisteredTool[] {
  const tools: RegisteredTool[] = [];
  registerEffectWorkTopicTools(apiFor(tools), {
    ...world,
    environment,
    makeClient: () => runtime as unknown as WorkClientRuntime,
  });
  return tools;
}

function apiFor(tools: RegisteredTool[]): ExtensionAPI {
  return {
    registerTool(tool: ToolDefinition) {
      tools.push(tool as unknown as RegisteredTool);
    },
  } as unknown as ExtensionAPI;
}

function context(cwd: string): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "print",
    ui: {},
  } as unknown as ExtensionContext;
}

function emptySnapshot(): WorkSnapshot {
  return {
    daemon: { id: "daemon", startedAt: "2026-01-01T00:00:00.000Z" },
    revision: 0,
    durable: { topics: [], repositoryStates: [], operations: [] },
    observed: { topics: [], pullRequests: [], diagnostics: [], activeActions: [] },
  };
}

function snapshot(parent: DurableTopic): WorkSnapshot {
  return {
    ...emptySnapshot(),
    durable: { topics: [{ rowRevision: 0, topic: parent }], repositoryStates: [], operations: [] },
  };
}

function parentTopic(path: string, branch: string): DurableTopic {
  return {
    id: parentId,
    name: "Parent",
    repository: "acme/widgets" as DurableTopic["repository"],
    branch: branch as DurableTopic["branch"],
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
      completedCommandCount: 0,
    },
    worktreePath: AbsolutePath.make(path),
    mainAgent: { sessionId: "session", sessionFile: null },
    partition: 2,
    integrationTarget: { kind: "integration-branch" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function operation(
  state: DurableOperation["state"],
  phase: string,
  result?: DurableOperation["result"],
): DurableOperation {
  return {
    id: operationId,
    clientId,
    requestId: "81000000-0000-4000-8000-000000000004" as never,
    state,
    phase,
    input: { version: 1, kind: "topic.provision", value: {} },
    ...(result === undefined ? {} : { result }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:01.000Z",
    revision: 1,
  };
}
