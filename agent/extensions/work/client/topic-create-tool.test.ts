import { describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { WorkEvent } from "../daemon/protocol.ts";
import type { TopicMutationResult } from "../daemon/topic-service.ts";
import type { TopicManifest } from "../shared/domain.ts";
import {
  resolveTopicCreationInput,
  type ResolvedTopicCreationInput,
  type TopicCreationInput,
} from "./topic-creation.ts";
import {
  registerWorkTopicCreateTool,
  type TopicCreateToolClient,
  type WorkTopicCreateToolDetails,
  type WorkTopicCreateInput,
} from "./topic-create-tool.ts";

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  execute(
    id: string,
    params: WorkTopicCreateInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<WorkTopicCreateToolDetails>>;
}

class FakeClient implements TopicCreateToolClient {
  readonly created: ResolvedTopicCreationInput[] = [];
  readonly createTimeouts: Array<number | undefined> = [];
  readonly confirmed: string[] = [];
  readonly rejected: string[] = [];
  closed = 0;
  events: WorkEvent[] = [];
  createResults: TopicMutationResult[] = [{ status: "ready", topic: readyTopic() }];
  confirmResults: TopicMutationResult[] = [{ status: "ready", topic: readyTopic() }];
  rejectResult: TopicMutationResult = { status: "rejected", topicId: "topic-id" };
  createOverride?: () => Promise<TopicMutationResult>;

  async subscribe(handler: (event: WorkEvent) => void): Promise<unknown> {
    for (const event of this.events) handler(event);
    return {};
  }

  createTopic(
    input: ResolvedTopicCreationInput,
    _requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    this.created.push(input);
    this.createTimeouts.push(timeoutMs);
    if (this.createOverride !== undefined) return this.createOverride();
    return Promise.resolve(this.createResults.shift()!);
  }

  confirm(token: string): Promise<TopicMutationResult> {
    this.confirmed.push(token);
    return Promise.resolve(this.confirmResults.shift()!);
  }

  reject(token: string): Promise<TopicMutationResult> {
    this.rejected.push(token);
    return Promise.resolve(this.rejectResult);
  }

  close(): void {
    this.closed += 1;
  }
}

describe("work_topic_create registration", () => {
  test("registers once with focused parameters and model guidance", () => {
    const registered: RegisteredTool[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool as unknown as RegisteredTool);
      },
    } as unknown as ExtensionAPI;

    registerWorkTopicCreateTool(pi);
    registerWorkTopicCreateTool(pi);

    expect(registered).toHaveLength(1);
    const tool = registered[0]!;
    expect(tool.name).toBe("work_topic_create");
    expect(tool.parameters.required).toEqual(["name"]);
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "name",
      "repository",
      "branch",
      "startPoint",
      "sourceCheckout",
      "timeoutSeconds",
    ]);
    const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(
      " ",
    );
    expect(guidance).toContain("Create a work Topic from HEAD~2 named My contribution");
    expect(guidance).toContain("Create a work Topic for LedgerHQ/revault with Branch foo-bar");
    expect(guidance).toContain("does not open");
    expect(guidance).toContain("original request is not confirmation");
    expect(guidance).toContain("Never send an empty string");
    expect(guidance).toContain("needs no Source checkout");
    expect(guidance).toContain("timeoutSeconds");
    expect(tool.parameters.properties).not.toHaveProperty("approved");
  });
});

describe("work_topic_create execution", () => {
  test("defaults Source checkout to cwd and returns structured ready details", async () => {
    const client = new FakeClient();
    let resolverInput: TopicCreationInput | undefined;
    const tool = registeredTool({
      client,
      resolveInput: async (input) => {
        resolverInput = input;
        return { name: input.name, repository: "acme/widgets", branch: "my-contribution" };
      },
    });

    const result = await tool.execute(
      "call-1",
      { name: "My contribution" },
      undefined,
      undefined,
      context({ cwd: "/source", hasUI: false }),
    );

    expect(resolverInput).toEqual({ name: "My contribution", sourceCheckout: "/source" });
    expect(client.created).toEqual([
      { name: "My contribution", repository: "acme/widgets", branch: "my-contribution" },
    ]);
    expect(result.details).toMatchObject({
      status: "ready",
      topicId: "topic-id",
      repository: "acme/widgets",
      branch: "my-contribution",
      setupState: "ready",
      worktreePath: "/worktrees/topic-id",
    });
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(client.closed).toBe(1);
  });

  test("treats blank optional model arguments as omitted", async () => {
    const client = new FakeClient();
    const result = await registeredTool({
      client,
      resolveInput: resolveTopicCreationInput,
    }).execute(
      "call-blank-optionals",
      {
        name: "foo",
        repository: "LedgerHQ/sre-argocd",
        branch: "",
        startPoint: "",
        sourceCheckout: "",
      },
      undefined,
      undefined,
      context({ cwd: "/unrelated/checkout", hasUI: false }),
    );

    expect(client.created).toEqual([
      { name: "foo", repository: "LedgerHQ/sre-argocd", branch: "foo" },
    ]);
    expect(client.createTimeouts).toEqual([10 * 60_000]);
    expect(result.details).toMatchObject({
      status: "ready",
      repository: "acme/widgets",
      branch: "my-contribution",
    });
  });

  test("honors a user-requested wait timeout", async () => {
    const client = new FakeClient();
    await registeredTool({ client }).execute(
      "call-short-timeout",
      {
        name: "foo",
        repository: "LedgerHQ/sre-argocd",
        timeoutSeconds: 5,
      },
      undefined,
      undefined,
      context({ hasUI: false }),
    );

    expect(client.createTimeouts).toEqual([5_000]);
  });

  test("shows every ask as the daemon's exact direct dialog and confirms only approval", async () => {
    const client = new FakeClient();
    client.createResults = [confirmation("clone-token", "Clone this exact repository?")];
    client.confirmResults = [
      confirmation("worktree-token", "Create this exact Worktree?"),
      { status: "ready", topic: readyTopic() },
    ];
    const dialogs: Array<{ title: string; message: string }> = [];
    const tool = registeredTool({ client });

    const result = await tool.execute(
      "call-2",
      { name: "Explicit", repository: "acme/widgets", branch: "explicit" },
      undefined,
      undefined,
      context({
        hasUI: true,
        confirm: async (title, message) => {
          dialogs.push({ title, message });
          return true;
        },
      }),
    );

    expect(dialogs.map((dialog) => dialog.message)).toEqual([
      "Clone this exact repository?",
      "Create this exact Worktree?",
    ]);
    expect(client.confirmed).toEqual(["clone-token", "worktree-token"]);
    expect(client.rejected).toEqual([]);
    expect(result.details.status).toBe("ready");
  });

  test("returns confirmation-required headlessly and never confirms", async () => {
    const client = new FakeClient();
    client.createResults = [confirmation("token", "Exact approval text.")];
    const result = await registeredTool({ client }).execute(
      "call-3",
      { name: "Headless", repository: "acme/widgets", branch: "headless" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );

    expect(result.details).toMatchObject({
      status: "confirmation-required",
      action: "repository.clone",
      confirmationText: "Exact approval text.",
    });
    expect(client.confirmed).toEqual([]);
    expect(client.rejected).toEqual([]);
  });

  test("rejects the prepared action when the direct user declines", async () => {
    const client = new FakeClient();
    client.createResults = [confirmation("token", "Exact approval text.")];
    const result = await registeredTool({ client }).execute(
      "call-4",
      { name: "No", repository: "acme/widgets", branch: "no" },
      undefined,
      undefined,
      context({ hasUI: true, confirm: async () => false }),
    );

    expect(client.confirmed).toEqual([]);
    expect(client.rejected).toEqual(["token"]);
    expect(result.details.status).toBe("rejected");
  });

  test("returns a bounded policy denial without another action", async () => {
    const client = new FakeClient();
    client.createResults = [
      {
        status: "denied",
        reason: "Policy denied repository.clone.",
        topic: readyTopic(),
      },
    ];
    const result = await registeredTool({ client }).execute(
      "call-denied",
      { name: "Denied", repository: "acme/widgets", branch: "denied" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );

    expect(result.details).toMatchObject({
      status: "denied",
      message: "Policy denied repository.clone.",
    });
    expect(client.confirmed).toEqual([]);
    expect(client.rejected).toEqual([]);
  });

  test("reports only bounded semantic progress", async () => {
    const client = new FakeClient();
    const topic = readyTopic();
    client.events = [
      {
        type: "topic-added",
        topic: { ...topic, setup: { ...topic.setup, worktreeCreated: false } },
      },
      {
        type: "operation-changed",
        topicId: topic.id,
        operation: { topicId: topic.id, kind: "provision", state: "running", detail: "setup 2/3" },
      },
      { type: "setup-changed", topic },
    ];
    const updates: string[] = [];

    await registeredTool({ client }).execute(
      "call-5",
      { name: "Progress", repository: "acme/widgets", branch: "progress" },
      undefined,
      (update) => {
        const content = update.content[0];
        if (content?.type === "text") updates.push(content.text);
      },
      context({ hasUI: false }),
    );

    expect(updates).toEqual([
      "Resolving Topic input.",
      "Connecting to the work daemon.",
      "Preparing the repository clone.",
      "setup 2/3.",
      "Created the Topic Worktree.",
      "Provisioning the Topic.",
    ]);
    expect(updates.join(" ")).not.toContain("command output");
  });

  test("forwards cancellation to waiting and closes the client", async () => {
    const client = new FakeClient();
    client.createOverride = () => new Promise(() => undefined);
    const controller = new AbortController();
    const execution = registeredTool({ client }).execute(
      "call-6",
      { name: "Cancel", repository: "acme/widgets", branch: "cancel" },
      controller.signal,
      undefined,
      context({ hasUI: false }),
    );
    while (client.created.length === 0) await Promise.resolve();
    controller.abort();

    const result = await execution;
    expect(result.details).toMatchObject({
      status: "cancelled",
      code: "tool-call-cancelled",
      phase: "provision",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(
        "The tool call was cancelled during provision. Topic provisioning can continue",
      ),
    });
    expect(client.closed).toBeGreaterThanOrEqual(1);
  });

  test("reports cancellation before the daemon request as safe to retry", async () => {
    const client = new FakeClient();
    let resolving = false;
    const controller = new AbortController();
    const execution = registeredTool({
      client,
      resolveInput: () => {
        resolving = true;
        return new Promise(() => undefined);
      },
    }).execute(
      "call-before-request",
      { name: "Cancel before request" },
      controller.signal,
      undefined,
      context({ hasUI: false }),
    );
    while (!resolving) await Promise.resolve();
    controller.abort();

    const result = await execution;
    expect(result.details).toMatchObject({
      status: "cancelled",
      code: "tool-call-cancelled",
      phase: "resolve",
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("No Topic request was sent. Retry the tool call"),
    });
    expect(client.created).toHaveLength(0);
  });

  test("returns a distinct request timeout result", async () => {
    const client = new FakeClient();
    client.createOverride = () =>
      Promise.reject(
        Object.assign(new Error("Work daemon topic.create request timed out."), {
          code: "request-timeout",
        }),
      );

    const result = await registeredTool({ client }).execute(
      "call-timeout",
      { name: "Timeout", repository: "acme/widgets", branch: "timeout" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );

    expect(result.details).toMatchObject({
      status: "timeout",
      code: "request-timeout",
      phase: "provision",
    });
  });

  test("bounds repository mismatch, resolver, conflict, and disconnect failures", async () => {
    const resolver = registeredTool({
      client: new FakeClient(),
      resolveInput: () =>
        Promise.reject(Object.assign(new Error("x".repeat(500)), { code: "resolution" })),
    });
    const resolution = await resolver.execute(
      "call-7",
      { name: "Bad" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );
    expect(resolution.details.code).toBe("resolution");
    expect(
      resolution.content[0]?.type === "text" ? resolution.content[0].text.length : 0,
    ).toBeLessThan(230);

    const mismatch = await registeredTool({
      client: new FakeClient(),
      resolveInput: () =>
        Promise.reject(
          Object.assign(new Error("Source checkout origin does not match repository."), {
            code: "repository-mismatch",
          }),
        ),
    }).execute(
      "call-mismatch",
      { name: "Mismatch", repository: "other/widgets", startPoint: "HEAD" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );
    expect(mismatch.details.code).toBe("repository-mismatch");

    const conflictClient = new FakeClient();
    conflictClient.createOverride = () =>
      Promise.reject(
        Object.assign(new Error("A Topic with this Branch exists."), {
          code: "topic-branch-conflict",
          details: { existingTopicId: "other-id", existingTopicName: "Other" },
        }),
      );
    const conflict = await registeredTool({ client: conflictClient }).execute(
      "call-8",
      { name: "Conflict", repository: "acme/widgets", branch: "conflict" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );
    expect(conflict.details).toMatchObject({
      code: "topic-branch-conflict",
      existingTopicId: "other-id",
      existingTopicName: "Other",
    });

    const disconnectClient = new FakeClient();
    disconnectClient.createOverride = () =>
      Promise.reject(new Error("Work daemon connection closed."));
    const disconnect = await registeredTool({ client: disconnectClient }).execute(
      "call-9",
      { name: "Disconnect", repository: "acme/widgets", branch: "disconnect" },
      undefined,
      undefined,
      context({ hasUI: false }),
    );
    expect(disconnect.details).toMatchObject({
      status: "failed",
      code: "work-topic-create-failed",
    });
  });
});

function registeredTool(options: {
  client: FakeClient;
  resolveInput?: (input: TopicCreationInput) => Promise<ResolvedTopicCreationInput>;
}): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
    },
  } as unknown as ExtensionAPI;
  registerWorkTopicCreateTool(pi, {
    home: "/home/test",
    runtime: "/run/test",
    connect: () => Promise.resolve(options.client),
    resolveInput:
      options.resolveInput ??
      ((input) =>
        Promise.resolve({
          name: input.name,
          repository: input.repository ?? "acme/widgets",
          branch: input.branch ?? "generated",
        })),
    requestId: () => "request-id",
  });
  return registered!;
}

function context(options: {
  cwd?: string;
  hasUI: boolean;
  confirm?: (title: string, message: string) => Promise<boolean>;
}): ExtensionContext {
  return {
    cwd: options.cwd ?? "/cwd",
    hasUI: options.hasUI,
    mode: options.hasUI ? "tui" : "print",
    ui: {
      confirm: options.confirm ?? (() => Promise.resolve(false)),
    },
  } as unknown as ExtensionContext;
}

function confirmation(token: string, text: string): TopicMutationResult {
  return {
    status: "confirmation-required",
    token,
    action: token.includes("worktree") ? "topic.create-worktree" : "repository.clone",
    topicId: "topic-id",
    expiresAt: "2099-01-01T00:00:00.000Z",
    text,
  };
}

function readyTopic(): TopicManifest {
  return {
    version: 1,
    id: "topic-id",
    name: "My contribution",
    repository: "acme/widgets",
    branch: "my-contribution",
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    worktreePath: "/worktrees/topic-id",
    mainAgent: { sessionId: "session-id", sessionFile: null },
    focused: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
