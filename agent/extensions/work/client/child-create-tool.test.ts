import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { testGitEnvironment } from "../test-support/git-environment.ts";
import { CLI_EXIT, runPiWorkCli, type TopicCreationClient } from "./cli.ts";
import {
  registerWorkTopicCreateChildTool,
  type ChildTopicCreateToolClient,
  type WorkTopicCreateChildInput,
} from "./child-create-tool.ts";
import type { ResolvedChildTopicCreationInput } from "./topic-creation.ts";
import type { WorkTopicCreateToolDetails } from "./topic-create-runtime.ts";

const PARENT_TOPIC_ID = "11111111-2222-4333-8444-555555555555";

interface RegisteredTool {
  name: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: { required?: string[]; properties?: Record<string, unknown> };
  execute(
    id: string,
    params: WorkTopicCreateChildInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<WorkTopicCreateToolDetails>>;
}

class FakeChildClient implements ChildTopicCreateToolClient {
  readonly created: ResolvedChildTopicCreationInput[] = [];
  readonly createTimeouts: Array<number | undefined> = [];
  readonly confirmed: string[] = [];
  readonly rejected: string[] = [];
  closed = 0;
  events: WorkEvent[] = [];
  createResults: TopicMutationResult[] = [{ status: "ready", topic: childTopic() }];
  confirmResults: TopicMutationResult[] = [{ status: "ready", topic: childTopic() }];
  rejectResult: TopicMutationResult = { status: "rejected", topicId: "child-id" };
  createOverride?: () => Promise<TopicMutationResult>;
  private handler?: (event: WorkEvent) => void;

  async subscribe(handler: (event: WorkEvent) => void): Promise<unknown> {
    this.handler = handler;
    for (const event of this.events) handler(event);
    return {};
  }

  emit(event: WorkEvent): void {
    this.handler?.(event);
  }

  createChildTopic(
    input: ResolvedChildTopicCreationInput,
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

let temporaryDirectory = "";
let repository = "";
let commits: string[] = [];

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "work-child-input-"));
  repository = join(temporaryDirectory, "source");
  await mkdir(repository);
  git("init", "-q");
  git("config", "user.name", "Test User");
  git("config", "user.email", "test@example.com");
  git("remote", "add", "origin", "https://github.com/acme/widgets.git");
  for (const content of ["one", "two", "three"]) {
    await Bun.write(join(repository, "item.txt"), content);
    git("add", "item.txt");
    git("commit", "-qm", content);
    commits.push(git("rev-parse", "HEAD"));
  }
});

afterEach(async () => {
  commits = [];
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("work_topic_create_child registration", () => {
  test("registers once with a narrow schema and commit-aware guidance", () => {
    const registered: RegisteredTool[] = [];
    const pi = {
      registerTool(tool: ToolDefinition) {
        registered.push(tool as unknown as RegisteredTool);
      },
    } as unknown as ExtensionAPI;

    registerWorkTopicCreateChildTool(pi);
    registerWorkTopicCreateChildTool(pi);

    expect(registered).toHaveLength(1);
    const tool = registered[0]!;
    expect(tool.name).toBe("work_topic_create_child");
    expect(tool.parameters.required).toEqual(["name", "startPoint"]);
    expect(Object.keys(tool.parameters.properties ?? {})).toEqual([
      "name",
      "startPoint",
      "parentTopicId",
      "branch",
      "sourceCheckout",
      "timeoutSeconds",
    ]);
    const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(
      " ",
    );
    expect(guidance).toContain("git log");
    expect(guidance).toContain("Never invent a name from a SHA");
    expect(guidance).toContain("Omit branch unless the user stated an exact Branch name");
    expect(guidance).toContain("Omit parentTopicId inside a Parent Main Agent");
    expect(tool.parameters.properties).not.toHaveProperty("approved");
    expect(tool.parameters.properties).not.toHaveProperty("repository");
  });
});

describe("work_topic_create_child execution", () => {
  test("resolves a natural revision in the session checkout and reports ready details", async () => {
    const client = new FakeChildClient();
    const updates: string[] = [];
    const tool = registeredTool(client, { PI_WORK_TOPIC_ID: PARENT_TOPIC_ID });
    client.events = [
      {
        type: "topic-added",
        topic: { ...childTopic(), setup: { ...childTopic().setup, worktreeCreated: false } },
      },
    ];

    const result = await tool.execute(
      "call-child-1",
      { name: "Widen the note column", startPoint: "HEAD~1" },
      undefined,
      (update) => {
        for (const item of update.content ?? []) {
          if (item.type === "text") updates.push(item.text);
        }
      },
      context({ cwd: repository, hasUI: false }),
    );

    expect(client.created).toEqual([
      {
        parentTopicId: PARENT_TOPIC_ID,
        name: "Widen the note column",
        branch: "widen-the-note-column",
        startPoint: { commit: commits[1]!, sourceCheckout: repository },
      },
    ]);
    expect(result.details).toMatchObject({
      status: "ready",
      topicId: "child-id",
      repository: "acme/widgets",
      branch: "widen-the-note-column",
      setupState: "ready",
    });
    expect(updates.join(" ")).toContain("Preparing the repository clone.");
    expect(client.closed).toBe(1);
  });

  test("keeps an explicit Branch and an explicit SHA exactly", async () => {
    const client = new FakeChildClient();
    await registeredTool(client).execute(
      "call-child-2",
      {
        name: "Second commit work",
        startPoint: commits[1]!,
        branch: "Feature/Keep-Case",
        parentTopicId: PARENT_TOPIC_ID,
        timeoutSeconds: 5,
      },
      undefined,
      undefined,
      context({ cwd: repository, hasUI: false }),
    );

    expect(client.created[0]).toMatchObject({
      branch: "Feature/Keep-Case",
      startPoint: { commit: commits[1]!, sourceCheckout: repository },
    });
    expect(client.createTimeouts).toEqual([5_000]);
  });

  test("fails directly without a Parent Topic in the session", async () => {
    const client = new FakeChildClient();
    const result = await registeredTool(client).execute(
      "call-child-3",
      { name: "Orphan", startPoint: "HEAD" },
      undefined,
      undefined,
      context({ cwd: repository, hasUI: false }),
    );

    expect(result.details).toMatchObject({
      status: "failed",
      code: "parent-topic-required",
      phase: "resolve",
    });
    expect(client.created).toHaveLength(0);
  });

  test("returns a confirmation requirement without a UI and follows the Recipe steps", async () => {
    const client = new FakeChildClient();
    client.createResults = [
      {
        status: "confirmation-required",
        token: "secret-token",
        action: "topic.create-worktree",
        topicId: "child-id",
        expiresAt: "2099-01-01T00:00:00.000Z",
        text: "Create the child Worktree?",
      },
    ];
    const updates: string[] = [];
    client.events = [
      { type: "topic-added", topic: { ...childTopic(), branch: "ask-first" } },
      {
        type: "operation-changed",
        topicId: "child-id",
        operation: {
          topicId: "child-id",
          kind: "provision",
          state: "running",
          detail: "setup 2/3",
        },
      },
    ];

    const result = await registeredTool(client).execute(
      "call-child-4",
      { name: "Ask first", startPoint: "HEAD", parentTopicId: PARENT_TOPIC_ID },
      undefined,
      (update) => {
        for (const item of update.content ?? []) {
          if (item.type === "text") updates.push(item.text);
        }
      },
      context({ cwd: repository, hasUI: false }),
    );

    expect(result.details).toMatchObject({
      status: "confirmation-required",
      topicId: "child-id",
      branch: "ask-first",
      action: "topic.create-worktree",
    });
    expect(result.details?.repository).toBeUndefined();
    expect(client.confirmed).toHaveLength(0);
    expect(updates.join(" ")).toContain("setup 2/3.");
  });

  test("reports cancellation and closes the daemon connection", async () => {
    const client = new FakeChildClient();
    const controller = new AbortController();
    client.createOverride = () =>
      new Promise<TopicMutationResult>(() => {
        controller.abort();
      });

    const result = await registeredTool(client).execute(
      "call-child-5",
      { name: "Cancelled", startPoint: "HEAD", parentTopicId: PARENT_TOPIC_ID },
      controller.signal,
      undefined,
      context({ cwd: repository, hasUI: false }),
    );

    expect(result.details).toMatchObject({ status: "cancelled", code: "tool-call-cancelled" });
    expect(client.closed).toBeGreaterThan(0);
  });

  test("sends the same resolved daemon input as the CLI for an equivalent request", async () => {
    const client = new FakeChildClient();
    await registeredTool(client, { PI_WORK_TOPIC_ID: PARENT_TOPIC_ID }).execute(
      "call-child-6",
      { name: "Shared request", startPoint: "HEAD~2" },
      undefined,
      undefined,
      context({ cwd: repository, hasUI: false }),
    );

    const cliClient = new CliChildClient();
    const exit = await runPiWorkCli(
      ["topic", "create-child", "--name", "Shared request", "--start-point", "HEAD~2"],
      {
        cwd: repository,
        home: "/home/test",
        runtime: "/run/test",
        environment: { PI_WORK_TOPIC_ID: PARENT_TOPIC_ID },
        loadConfig: async () => ({
          version: 1,
          workBase: "/work",
          policies: { defaults: {}, repositories: {}, topics: {} },
          repositories: {},
        }),
        connect: async () => cliClient,
        onSignal: () => () => undefined,
        writeStdout: () => undefined,
        writeStderr: () => undefined,
      },
    );

    expect(exit).toBe(CLI_EXIT.success);
    expect(cliClient.created).toEqual(client.created);
  });
});

class CliChildClient implements TopicCreationClient {
  readonly created: ResolvedChildTopicCreationInput[] = [];

  createTopic(): Promise<TopicMutationResult> {
    throw new Error("unused");
  }

  createChildTopic(input: ResolvedChildTopicCreationInput): Promise<TopicMutationResult> {
    this.created.push(input);
    return Promise.resolve({ status: "ready", topic: childTopic() });
  }

  confirm(): Promise<TopicMutationResult> {
    throw new Error("unused");
  }

  reject(): Promise<TopicMutationResult> {
    throw new Error("unused");
  }

  close(): void {}
}

function registeredTool(
  client: FakeChildClient,
  environment: Record<string, string | undefined> = {},
): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const pi = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
    },
  } as unknown as ExtensionAPI;
  registerWorkTopicCreateChildTool(pi, {
    home: "/home/test",
    runtime: "/run/test",
    connect: () => Promise.resolve(client),
    environment,
    requestId: () => "request-id",
  });
  return registered!;
}

function context(options: { cwd: string; hasUI: boolean }): ExtensionContext {
  return {
    cwd: options.cwd,
    hasUI: options.hasUI,
    mode: options.hasUI ? "tui" : "print",
    ui: { confirm: () => Promise.resolve(false) },
  } as unknown as ExtensionContext;
}

function childTopic(): TopicManifest {
  return {
    version: 1,
    id: "child-id",
    name: "Child Topic",
    repository: "acme/widgets",
    branch: "widen-the-note-column",
    setup: {
      state: "ready",
      repositoryAvailable: true,
      worktreeCreated: true,
      setupCommandsRun: true,
    },
    worktreePath: "/worktrees/child-id",
    mainAgent: { sessionId: "session-id", sessionFile: null },
    focused: true,
    parentTopicId: PARENT_TOPIC_ID,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repository,
    env: testGitEnvironment(repository),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
