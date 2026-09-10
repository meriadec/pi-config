import { describe, expect, test } from "bun:test";
import type { TopicMutationResult } from "../daemon/topic-service.ts";
import type { WorkConfig } from "../shared/domain.ts";
import {
  CLI_EXIT,
  CLI_PROVISION_TIMEOUT_MS,
  runPiWorkCli,
  type CliDependencies,
  type TopicCreationClient,
} from "./cli.ts";
import type {
  ChildTopicCreationInput,
  ResolvedChildTopicCreationInput,
  ResolvedTopicCreationInput,
  TopicCreationInput,
} from "./topic-creation.ts";

const PARENT_TOPIC_ID = "11111111-2222-4333-8444-555555555555";

const CONFIG: WorkConfig = {
  version: 1,
  workBase: "/work",
  policies: { defaults: {}, repositories: {}, topics: {} },
  repositories: {},
};

class FakeClient implements TopicCreationClient {
  readonly creates: Array<{
    input: ResolvedTopicCreationInput;
    requestId: string | undefined;
    timeoutMs: number | undefined;
  }> = [];
  readonly childCreates: Array<{
    input: ResolvedChildTopicCreationInput;
    requestId: string | undefined;
    timeoutMs: number | undefined;
  }> = [];
  readonly confirmations: string[] = [];
  readonly rejections: string[] = [];
  closed = false;
  private readonly results: TopicMutationResult[];

  constructor(results: TopicMutationResult[]) {
    this.results = results;
  }

  createTopic(
    input: ResolvedTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    this.creates.push({ input, requestId, timeoutMs });
    return this.next();
  }

  createChildTopic(
    input: ResolvedChildTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult> {
    this.childCreates.push({ input, requestId, timeoutMs });
    return this.next();
  }

  confirm(token: string): Promise<TopicMutationResult> {
    this.confirmations.push(token);
    return this.next();
  }

  reject(token: string): Promise<TopicMutationResult> {
    this.rejections.push(token);
    return this.next();
  }

  close(): void {
    this.closed = true;
  }

  private async next(): Promise<TopicMutationResult> {
    const result = this.results.shift();
    if (result === undefined) throw new Error("Fake result queue is empty.");
    return result;
  }
}

function ready(): Extract<TopicMutationResult, { status: "ready" }> {
  return {
    status: "ready",
    topic: {
      version: 1,
      id: "topic-1",
      name: "My contribution",
      repository: "LedgerHQ/revault",
      branch: "foo-bar",
      setup: {
        state: "ready",
        repositoryAvailable: true,
        worktreeCreated: true,
        setupCommandsRun: true,
      },
      worktreePath: "/work/revault/foo-bar",
      mainAgent: { sessionId: "", sessionFile: null },
      partition: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function ask(
  action: "repository.clone" | "topic.create-worktree" | "topic.run-setup",
  index: number,
): TopicMutationResult {
  return {
    status: "confirmation-required",
    token: `secret-${index}`,
    action,
    topicId: "topic-1",
    expiresAt: "2026-01-01T00:01:00.000Z",
    text: `Exact confirmation ${index}?`,
  };
}

function harness(client: TopicCreationClient, overrides: CliDependencies = {}) {
  let stdout = "";
  let stderr = "";
  const resolvedInputs: TopicCreationInput[] = [];
  const dependencies: CliDependencies = {
    cwd: "/current/checkout",
    home: "/home/test",
    runtime: "/run/test",
    loadConfig: async () => CONFIG,
    resolveInput: async (input) => {
      resolvedInputs.push(input);
      return {
        name: input.name.trim(),
        repository: input.repository ?? "LedgerHQ/revault",
        branch: input.branch ?? "my-contribution",
        ...(input.startPoint === undefined
          ? {}
          : { startPoint: { commit: "a".repeat(40), sourceCheckout: input.sourceCheckout! } }),
      };
    },
    connect: async () => client,
    requestId: () => "request-1",
    onSignal: () => () => undefined,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: (text) => {
      stderr += text;
    },
    ...overrides,
  };
  return {
    dependencies,
    resolvedInputs,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("pi-work CLI parsing and output", () => {
  test("maps both agreed examples to explicit daemon requests", async () => {
    const firstClient = new FakeClient([ready()]);
    const first = harness(firstClient);
    expect(
      await runPiWorkCli(
        ["topic", "create", "--name", "My contribution", "--start-point", "HEAD~2"],
        first.dependencies,
      ),
    ).toBe(CLI_EXIT.success);
    expect(first.resolvedInputs).toEqual([
      {
        name: "My contribution",
        startPoint: "HEAD~2",
        sourceCheckout: "/current/checkout",
      },
    ]);
    expect(firstClient.creates[0]).toEqual({
      input: {
        name: "My contribution",
        repository: "LedgerHQ/revault",
        branch: "my-contribution",
        startPoint: { commit: "a".repeat(40), sourceCheckout: "/current/checkout" },
      },
      requestId: "request-1",
      timeoutMs: CLI_PROVISION_TIMEOUT_MS,
    });

    const secondClient = new FakeClient([ready()]);
    const second = harness(secondClient);
    expect(
      await runPiWorkCli(
        [
          "topic",
          "create",
          "--name",
          "My contribution",
          "--repository",
          "LedgerHQ/revault",
          "--branch",
          "foo-bar",
        ],
        second.dependencies,
      ),
    ).toBe(CLI_EXIT.success);
    expect(secondClient.creates[0]?.input).toEqual({
      name: "My contribution",
      repository: "LedgerHQ/revault",
      branch: "foo-bar",
    });
  });

  test("uses the current directory by default and accepts an explicit Source checkout", async () => {
    const implicit = harness(new FakeClient([ready()]));
    await runPiWorkCli(["topic", "create", "--name", "Implicit"], implicit.dependencies);
    expect(implicit.resolvedInputs[0]?.sourceCheckout).toBe("/current/checkout");

    const explicit = harness(new FakeClient([ready()]));
    await runPiWorkCli(
      ["topic", "create", "--name", "Explicit", "--source-checkout", "/other/checkout"],
      explicit.dependencies,
    );
    expect(explicit.resolvedInputs[0]?.sourceCheckout).toBe("/other/checkout");
  });

  test("sends the resolved child request for `topic create-child`", async () => {
    const client = new FakeClient([ready()]);
    const resolvedChildInputs: ChildTopicCreationInput[] = [];
    const exit = await runPiWorkCli(
      [
        "topic",
        "create-child",
        "--name",
        "Widen the note column",
        "--start-point",
        "HEAD~1",
        "--branch",
        "Feature/Keep-Case",
      ],
      harness(client, {
        environment: { PI_WORK_TOPIC_ID: PARENT_TOPIC_ID },
        resolveChildInput: async (input, options) => {
          resolvedChildInputs.push(input);
          return {
            parentTopicId: options?.environment?.["PI_WORK_TOPIC_ID"] ?? "unset",
            name: input.name,
            branch: input.branch ?? "derived",
            startPoint: { commit: "b".repeat(40), sourceCheckout: input.sourceCheckout! },
          };
        },
      }).dependencies,
    );

    expect(exit).toBe(CLI_EXIT.success);
    expect(resolvedChildInputs).toEqual([
      {
        name: "Widen the note column",
        startPoint: "HEAD~1",
        branch: "Feature/Keep-Case",
        sourceCheckout: "/current/checkout",
      },
    ]);
    expect(client.childCreates[0]).toEqual({
      input: {
        parentTopicId: PARENT_TOPIC_ID,
        name: "Widen the note column",
        branch: "Feature/Keep-Case",
        startPoint: { commit: "b".repeat(40), sourceCheckout: "/current/checkout" },
      },
      requestId: "request-1",
      timeoutMs: CLI_PROVISION_TIMEOUT_MS,
    });
    expect(client.creates).toHaveLength(0);
  });

  test("rejects child syntax that the daemon operation cannot accept", async () => {
    const missingStartPoint = harness(new FakeClient([]));
    expect(
      await runPiWorkCli(
        ["topic", "create-child", "--name", "Child"],
        missingStartPoint.dependencies,
      ),
    ).toBe(CLI_EXIT.usage);
    expect(missingStartPoint.stderr()).toContain("--start-point is required");

    const repositoryFlag = harness(new FakeClient([]));
    expect(
      await runPiWorkCli(
        [
          "topic",
          "create-child",
          "--name",
          "Child",
          "--start-point",
          "HEAD",
          "--repository",
          "a/b",
        ],
        repositoryFlag.dependencies,
      ),
    ).toBe(CLI_EXIT.usage);
    expect(repositoryFlag.stderr()).toContain("Unknown option: --repository");

    const parentFlag = harness(new FakeClient([]));
    expect(
      await runPiWorkCli(
        ["topic", "create", "--name", "Topic", "--parent-topic-id", PARENT_TOPIC_ID],
        parentFlag.dependencies,
      ),
    ).toBe(CLI_EXIT.usage);
    expect(parentFlag.stderr()).toContain("pi-work topic create-child");
  });

  test("rejects invalid syntax before connecting", async () => {
    let connected = false;
    const item = harness(new FakeClient([]), {
      connect: async () => {
        connected = true;
        return new FakeClient([]);
      },
    });
    expect(await runPiWorkCli(["topic", "create", "--json"], item.dependencies)).toBe(
      CLI_EXIT.usage,
    );
    expect(connected).toBe(false);
    expect(item.stderr()).toContain("--name is required");
  });

  test("emits one stable JSON success object and keeps diagnostics on stderr", async () => {
    const item = harness(new FakeClient([ready()]));
    expect(
      await runPiWorkCli(
        ["topic", "create", "--name", "My contribution", "--json"],
        item.dependencies,
      ),
    ).toBe(0);
    expect(item.stdout().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(item.stdout())).toEqual({
      version: 1,
      status: "ready",
      topicId: "topic-1",
      name: "My contribution",
      repository: "LedgerHQ/revault",
      branch: "foo-bar",
      setupState: "ready",
      worktreePath: "/work/revault/foo-bar",
    });
    expect(item.stderr()).toBe(
      "Resolving Topic input.\nConnecting to pi-workd.\nProvisioning Topic.\n",
    );
  });

  test("does not configure or connect when WORK_BASE is absent", async () => {
    let connected = false;
    const item = harness(new FakeClient([]), {
      loadConfig: async () => null,
      connect: async () => {
        connected = true;
        return new FakeClient([]);
      },
    });
    expect(
      await runPiWorkCli(["topic", "create", "--name", "Topic", "--json"], item.dependencies),
    ).toBe(1);
    expect(JSON.parse(item.stdout())).toMatchObject({ status: "error", code: "missing-work-base" });
    expect(connected).toBe(false);
  });
});

describe("pi-work CLI provisioning outcomes", () => {
  test("answers each interactive ask on the same client", async () => {
    const client = new FakeClient([
      ask("repository.clone", 1),
      ask("topic.create-worktree", 2),
      ready(),
    ]);
    const answers = ["maybe", "yes", "y"];
    const item = harness(client, {
      isInteractive: true,
      prompt: async () => answers.shift()!,
    });
    expect(await runPiWorkCli(["topic", "create", "--name", "Topic"], item.dependencies)).toBe(0);
    expect(client.confirmations).toEqual(["secret-1", "secret-2"]);
    expect(item.stderr()).toContain("Exact confirmation 1?\n");
    expect(item.stderr()).toContain("Exact confirmation 2?\n");
  });

  test("a direct no rejects instead of approving", async () => {
    const client = new FakeClient([
      ask("repository.clone", 1),
      { status: "rejected", topicId: "topic-1" },
    ]);
    const item = harness(client, { isInteractive: true, prompt: async () => "no" });
    expect(await runPiWorkCli(["topic", "create", "--name", "Topic"], item.dependencies)).toBe(
      CLI_EXIT.denied,
    );
    expect(client.confirmations).toEqual([]);
    expect(client.rejections).toEqual(["secret-1"]);
  });

  test.each([
    ["non-interactive", false, false],
    ["JSON", true, true],
  ])("returns confirmation-required in %s mode", async (_label, json, isInteractive) => {
    const client = new FakeClient([ask("repository.clone", 1)]);
    const item = harness(client, { isInteractive });
    const args = ["topic", "create", "--name", "Topic", ...(json ? ["--json"] : [])];
    expect(await runPiWorkCli(args, item.dependencies)).toBe(CLI_EXIT.confirmationRequired);
    expect(client.confirmations).toEqual([]);
    if (json)
      expect(JSON.parse(item.stdout())).toMatchObject({
        status: "confirmation-required",
        action: "repository.clone",
      });
  });

  test.each([
    [
      { status: "denied", reason: "Policy denied.", topic: ready().topic } as TopicMutationResult,
      CLI_EXIT.denied,
    ],
    [
      {
        status: "timeout",
        reason: "Setup timed out.",
        topic: ready().topic,
      } as TopicMutationResult,
      CLI_EXIT.timeout,
    ],
    [
      {
        status: "failed",
        code: "clone-failed",
        reason: "Clone failed.",
        topic: ready().topic,
      } as TopicMutationResult,
      CLI_EXIT.failure,
    ],
  ])("maps terminal daemon results to exit codes", async (result, exitCode) => {
    const item = harness(new FakeClient([result]));
    expect(
      await runPiWorkCli(["topic", "create", "--name", "Topic", "--json"], item.dependencies),
    ).toBe(exitCode);
  });

  test("keeps conflict details in the bounded JSON error", async () => {
    const conflict = Object.assign(new Error("Branch belongs to another Topic."), {
      code: "topic-conflict",
      details: { existingTopicId: "topic-old", existingTopicName: "Old Topic" },
    });
    const item = harness({
      createTopic: async () => {
        throw conflict;
      },
      createChildTopic: async () => {
        throw conflict;
      },
      confirm: async () => {
        throw new Error("unused");
      },
      reject: async () => {
        throw new Error("unused");
      },
      close: () => undefined,
    });
    expect(
      await runPiWorkCli(["topic", "create", "--name", "Topic", "--json"], item.dependencies),
    ).toBe(CLI_EXIT.failure);
    expect(JSON.parse(item.stdout())).toMatchObject({
      status: "error",
      code: "topic-conflict",
      details: { existingTopicId: "topic-old", existingTopicName: "Old Topic" },
    });
  });

  test("reports disconnect and Ctrl-C without success", async () => {
    const disconnected = harness({
      createTopic: async () => {
        throw new Error("Work daemon connection closed.");
      },
      createChildTopic: async () => {
        throw new Error("unused");
      },
      confirm: async () => {
        throw new Error("unused");
      },
      reject: async () => {
        throw new Error("unused");
      },
      close: () => undefined,
    });
    expect(
      await runPiWorkCli(["topic", "create", "--name", "Topic"], disconnected.dependencies),
    ).toBe(1);

    let signal: (() => void) | undefined;
    let rejectRequest: ((error: Error) => void) | undefined;
    let closed = false;
    const cancelledClient: TopicCreationClient = {
      createTopic: () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        }),
      createChildTopic: async () => {
        throw new Error("unused");
      },
      confirm: async () => {
        throw new Error("unused");
      },
      reject: async () => {
        throw new Error("unused");
      },
      close: () => {
        closed = true;
        rejectRequest?.(new Error("closed"));
      },
    };
    const cancelled = harness(cancelledClient, {
      onSignal: (handler) => {
        signal = handler;
        return () => undefined;
      },
    });
    const pending = runPiWorkCli(
      ["topic", "create", "--name", "Topic", "--json"],
      cancelled.dependencies,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.();
    expect(await pending).toBe(CLI_EXIT.cancelled);
    expect(closed).toBe(true);
    expect(JSON.parse(cancelled.stdout())).toMatchObject({ status: "error", code: "cancelled" });
  });
});
