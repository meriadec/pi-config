import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkClient } from "./client.ts";
import { runPiWorkCli, type TopicCreationClient } from "./cli.ts";
import {
  registerWorkTopicCreateTool,
  type TopicCreateToolClient,
  type WorkTopicCreateToolDetails,
} from "./topic-create-tool.ts";
import {
  resolveTopicCreationInput,
  type ResolvedTopicCreationInput,
  type TopicCreationInput,
} from "./topic-creation.ts";
import { LocalProcessRunner } from "../daemon/process-runner.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../daemon/process-runner.ts";
import { TopicProvisioner } from "../daemon/provisioner.ts";
import { WorkDaemon } from "../daemon/server.ts";
import { TopicService } from "../daemon/topic-service.ts";
import {
  ACTION_IDS,
  createConfigStore,
  createTopicStore,
  createWorkPaths,
} from "../shared/index.ts";
import type { ActionId, WorkPaths } from "../shared/index.ts";
import { testGitEnvironment } from "../test-support/git-environment.ts";

const roots: string[] = [];
const worlds: IntegrationWorld[] = [];

interface RegisteredTool {
  execute(
    id: string,
    params: TopicCreationInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
    context: ExtensionContext,
  ): Promise<AgentToolResult<WorkTopicCreateToolDetails>>;
}

class GitWorktreeRunner implements ProcessRunner {
  readonly commands: string[] = [];
  private readonly delegate = new LocalProcessRunner();
  private readonly worktrees: string;
  gate: Promise<void> | undefined;

  constructor(worktrees: string) {
    this.worktrees = worktrees;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.commands.push(request.command);
    if (request.command !== "wt") {
      return this.delegate.run({ ...request, env: testGitEnvironment(request.cwd) });
    }
    await this.gate;
    const create = request.args[1] === "--create";
    const branch = request.args[create ? 2 : 1];
    if (branch === undefined) throw new Error("The wt request has no Branch.");
    const target = join(this.worktrees, branch.replaceAll("/", "--"));
    await mkdir(this.worktrees, { recursive: true });
    const result = await this.delegate.run({
      ...request,
      command: "git",
      args: create
        ? ["worktree", "add", "-b", branch, target]
        : ["worktree", "add", target, branch],
      env: testGitEnvironment(request.cwd),
    });
    return result.status === "completed" && result.exitCode === 0
      ? { ...result, stdout: JSON.stringify({ path: target }) }
      : result;
  }
}

interface IntegrationWorld {
  root: string;
  source: string;
  base: string;
  paths: WorkPaths;
  runner: GitWorktreeRunner;
  commit: string;
  daemon: WorkDaemon;
  service: TopicService;
  stop(): Promise<void>;
}

afterEach(async () => {
  for (const item of worlds.splice(0)) await item.stop().catch(() => undefined);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function integrationWorld(
  overrides: Partial<Record<ActionId, "allow" | "ask" | "deny">> = {},
): Promise<IntegrationWorld> {
  const root = await mkdtemp(join(tmpdir(), "work-topic-create-integration-"));
  roots.push(root);
  const workBase = join(root, "work-base");
  const base = join(workBase, "widgets");
  const source = join(root, "source");
  const runtime = join(root, "runtime");
  await mkdir(workBase, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await git(root, "init", "--initial-branch=main", base);
  await git(base, "config", "user.name", "Integration Test");
  await git(base, "config", "user.email", "integration@example.com");
  await git(base, "remote", "add", "origin", "git@github.com:acme/widgets.git");
  await writeFile(join(base, "history.txt"), "base\n");
  await git(base, "add", "history.txt");
  await git(base, "commit", "-m", "base");
  await git(base, "worktree", "add", "-b", "local-feature", source);
  const commits: string[] = [];
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(join(source, "history.txt"), `base\nfeature ${index}\n`);
    await git(source, "commit", "-am", `feature ${index}`);
    commits.push(await git(source, "rev-parse", "HEAD"));
  }

  const paths = createWorkPaths({ home: join(root, "home"), runtime });
  await createConfigStore(paths).save({
    version: 1,
    workBase,
    policies: {
      defaults: Object.fromEntries(
        ACTION_IDS.map((action) => [action, overrides[action] ?? "allow"]),
      ),
      repositories: {},
      topics: {},
    },
    repositories: {},
  });
  const topics = createTopicStore(paths);
  const runner = new GitWorktreeRunner(join(root, "topic-worktrees"));
  const service = new TopicService({
    config: createConfigStore(paths),
    topics,
    provisioner: new TopicProvisioner({ topics, runner }),
  });
  const daemon = new WorkDaemon({
    socketPath: paths.socket,
    runtimeDirectory: runtime,
    topicService: service,
  });
  await daemon.start();
  const item: IntegrationWorld = {
    root,
    source,
    base,
    paths,
    runner,
    commit: commits[0]!,
    daemon,
    service,
    async stop() {
      service.stop();
      await daemon.stop();
    },
  };
  worlds.push(item);
  return item;
}

function capturingClient(
  client: WorkClient,
  captured: ResolvedTopicCreationInput[],
): TopicCreateToolClient {
  return {
    createTopic(input, requestId, timeoutMs) {
      captured.push(input);
      return client.createTopic(input, requestId, timeoutMs);
    },
    confirm: (token, requestId, timeoutMs) => client.confirm(token, requestId, timeoutMs),
    reject: (token, requestId, timeoutMs) => client.reject(token, requestId, timeoutMs),
    subscribe: (handler, timeoutMs) => client.subscribe(handler, timeoutMs),
    close: () => client.close(),
  };
}

function registeredTool(
  connect: () => Promise<TopicCreateToolClient>,
  requestId = "integration-tool-request",
): RegisteredTool {
  let registered: RegisteredTool | undefined;
  const api = {
    registerTool(tool: ToolDefinition) {
      registered = tool as unknown as RegisteredTool;
    },
  } as unknown as ExtensionAPI;
  registerWorkTopicCreateTool(api, { connect, requestId: () => requestId, timeoutMs: 10_000 });
  return registered!;
}

function context(cwd: string, confirm?: (title: string, message: string) => Promise<boolean>) {
  return {
    cwd,
    hasUI: confirm !== undefined,
    mode: confirm === undefined ? "print" : "tui",
    ui: { confirm: confirm ?? (() => Promise.resolve(false)) },
  } as unknown as ExtensionContext;
}

async function runCli(
  item: IntegrationWorld,
  args: string[],
  captured: ResolvedTopicCreationInput[],
  options: { interactive?: boolean; json?: boolean; prompt?: () => Promise<string> } = {},
): Promise<{ exit: number; output: Record<string, unknown> }> {
  let stdout = "";
  const client = await WorkClient.connect(item.paths.socket, { clientId: "integration-cli" });
  const adapter: TopicCreationClient = {
    createTopic(input, requestId, timeoutMs) {
      captured.push(input);
      return client.createTopic(input, requestId, timeoutMs);
    },
    createChildTopic(input, requestId, timeoutMs) {
      return client.createChildTopic(input, requestId, timeoutMs);
    },
    confirm: (token, requestId, timeoutMs) => client.confirm(token, requestId, timeoutMs),
    reject: (token, requestId, timeoutMs) => client.reject(token, requestId, timeoutMs),
    close: () => client.close(),
  };
  const json = options.json ?? true;
  const exit = await runPiWorkCli(json ? [...args, "--json"] : args, {
    cwd: item.source,
    home: join(item.root, "home"),
    runtime: join(item.root, "runtime"),
    loadConfig: () => createConfigStore(item.paths).load(),
    connect: async () => adapter,
    requestId: () => "integration-cli-request",
    isInteractive: options.interactive ?? false,
    ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
    onSignal: () => () => undefined,
    writeStdout: (text) => {
      stdout += text;
    },
    writeStderr: () => undefined,
  });
  return { exit, output: json && stdout.length > 0 ? JSON.parse(stdout) : {} };
}

describe("agent-callable Topic creation integration", () => {
  test("CLI and Pi tool select the first of three local commits through the real daemon", async () => {
    const toolWorld = await integrationWorld();
    const toolInput: ResolvedTopicCreationInput[] = [];
    const tool = registeredTool(async () =>
      capturingClient(
        await WorkClient.connect(toolWorld.paths.socket, { clientId: "integration-tool" }),
        toolInput,
      ),
    );
    const toolResult = await tool.execute(
      "tool-call",
      { name: "My contribution", startPoint: "HEAD~2" },
      undefined,
      undefined,
      context(toolWorld.source),
    );

    expect(toolResult.details).toMatchObject({
      status: "ready",
      repository: "acme/widgets",
      branch: "my-contribution",
      setupState: "ready",
    });
    expect(toolInput).toEqual([
      {
        name: "My contribution",
        repository: "acme/widgets",
        branch: "my-contribution",
        startPoint: { commit: toolWorld.commit, sourceCheckout: toolWorld.source },
      },
    ]);
    const toolTopic = toolWorld.service.snapshot().topics[0]!;
    expect(await git(toolTopic.worktreePath!, "rev-parse", "HEAD")).toBe(toolWorld.commit);

    const cliWorld = await integrationWorld();
    const cliInput: ResolvedTopicCreationInput[] = [];
    const cli = await runCli(
      cliWorld,
      ["topic", "create", "--name", "My contribution", "--start-point", "HEAD~2"],
      cliInput,
    );
    expect(cli.exit).toBe(0);
    expect(cli.output).toMatchObject({
      status: "ready",
      repository: "acme/widgets",
      branch: "my-contribution",
      setupState: "ready",
    });
    expect(cliInput[0]).toMatchObject({
      name: toolInput[0]!.name,
      repository: toolInput[0]!.repository,
      branch: toolInput[0]!.branch,
      startPoint: { commit: cliWorld.commit, sourceCheckout: cliWorld.source },
    });
    const cliTopic = cliWorld.service.snapshot().topics[0]!;
    expect(await git(cliTopic.worktreePath!, "rev-parse", "HEAD")).toBe(cliWorld.commit);

    for (const [item, topic] of [
      [toolWorld, toolTopic],
      [cliWorld, cliTopic],
    ] as const) {
      const manifest = await readFile(item.paths.topicManifest(topic.id), "utf8");
      expect(manifest).not.toContain("startPoint");
      expect(manifest).not.toContain("sourceCheckout");
      expect(manifest).not.toContain(item.source);
      expect(JSON.stringify(item.service.snapshot())).not.toContain(item.source);
      expect(topic.mainAgent.sessionFile).toBeNull();
      expect(
        item.runner.commands.some((command) => ["pi", "i3-msg", "kitty"].includes(command)),
      ).toBeFalse();
    }
  });

  test("explicit creation works without a Start Point and ready state survives daemon restart", async () => {
    const item = await integrationWorld();
    const captured: ResolvedTopicCreationInput[] = [];
    const result = await runCli(
      item,
      [
        "topic",
        "create",
        "--name",
        "Explicit Topic",
        "--repository",
        "acme/widgets",
        "--branch",
        "explicit-topic",
      ],
      captured,
    );
    expect(result.exit).toBe(0);
    expect(captured).toEqual([
      { name: "Explicit Topic", repository: "acme/widgets", branch: "explicit-topic" },
    ]);
    const before = item.service.snapshot().topics[0]!;
    await item.stop();
    worlds.splice(worlds.indexOf(item), 1);

    const topics = createTopicStore(item.paths);
    const service = new TopicService({
      config: createConfigStore(item.paths),
      topics,
      provisioner: new TopicProvisioner({ topics, runner: item.runner }),
    });
    const daemon = new WorkDaemon({
      socketPath: item.paths.socket,
      runtimeDirectory: join(item.root, "runtime"),
      topicService: service,
    });
    await daemon.start();
    item.service = service;
    item.daemon = daemon;
    worlds.push(item);
    for (let attempt = 0; attempt < 50 && service.snapshot().operations.length > 0; attempt += 1) {
      await Bun.sleep(5);
    }
    const after = service.snapshot().topics[0]!;
    expect(after.id).toBe(before.id);
    expect(after.setup.state).toBe("ready");
    expect(after.worktreePath).toBe(before.worktreePath);
  });

  test("CLI and Pi tool require direct human confirmation on the real protocol", async () => {
    const cliWorld = await integrationWorld({ "topic.create-worktree": "ask" });
    const cliDialogs: string[] = [];
    const cli = await runCli(
      cliWorld,
      ["topic", "create", "--name", "CLI confirmed", "--start-point", "HEAD~2"],
      [],
      {
        interactive: true,
        json: false,
        prompt: async () => {
          cliDialogs.push("direct prompt");
          return "yes";
        },
      },
    );
    expect(cli.exit).toBe(0);
    expect(cliDialogs).toEqual(["direct prompt"]);
    expect(cliWorld.service.snapshot().topics[0]?.setup.state).toBe("ready");

    const toolWorld = await integrationWorld({ "topic.create-worktree": "ask" });
    const dialogs: string[] = [];
    const tool = registeredTool(async () =>
      capturingClient(
        await WorkClient.connect(toolWorld.paths.socket, { clientId: "confirming-tool" }),
        [],
      ),
    );
    const result = await tool.execute(
      "confirmation-call",
      { name: "Tool confirmed", startPoint: "HEAD~2" },
      undefined,
      undefined,
      context(toolWorld.source, async (_title, message) => {
        dialogs.push(message);
        return true;
      }),
    );
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toContain("topic.create-worktree");
    expect(result.details.status).toBe("ready");
  });

  test("tool cancellation stops waiting while daemon provisioning continues", async () => {
    const item = await integrationWorld();
    let release = (): void => undefined;
    item.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = registeredTool(async () =>
      capturingClient(
        await WorkClient.connect(item.paths.socket, { clientId: "cancelled-tool" }),
        [],
      ),
    );
    const controller = new AbortController();
    const execution = tool.execute(
      "cancelled-tool-call",
      { name: "Cancelled wait", startPoint: "HEAD~2" },
      controller.signal,
      undefined,
      context(item.source),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (item.service.snapshot().operations.some((operation) => operation.kind === "provision")) {
        break;
      }
      await Bun.sleep(5);
    }
    controller.abort();

    const cancelled = await execution;
    expect(cancelled.details).toMatchObject({
      status: "cancelled",
      code: "tool-call-cancelled",
      phase: "clone",
    });
    expect(item.service.snapshot().topics[0]?.setup.state).toBe("provisioning");

    release();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (item.service.snapshot().topics[0]?.setup.state === "ready") break;
      await Bun.sleep(5);
    }
    expect(item.service.snapshot().topics[0]?.setup.state).toBe("ready");
  });

  test("rejects an oversized request id locally instead of waiting for an uncorrelated error", async () => {
    const item = await integrationWorld();
    const client = await WorkClient.connect(item.paths.socket);

    await expect(
      client.createTopic(
        { name: "Never sent", repository: "acme/widgets", branch: "never-sent" },
        "x".repeat(201),
        50,
      ),
    ).rejects.toMatchObject({ code: "invalid-request-id" });
    expect(item.service.snapshot().topics).toHaveLength(0);
    client.close();
  });

  test("a timed-out client retry is deduplicated and Branch conflicts never move or suffix", async () => {
    const item = await integrationWorld();
    let release = (): void => undefined;
    item.runner.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = await WorkClient.connect(item.paths.socket, { clientId: "retry-client" });
    const input: ResolvedTopicCreationInput = {
      name: "Retry Topic",
      repository: "acme/widgets",
      branch: "retry-topic",
      startPoint: { commit: item.commit, sourceCheckout: item.source },
    };
    await expect(client.createTopic(input, "stable-request", 1)).rejects.toThrow("timed out");
    const retried = client.createTopic(input, "stable-request", 10_000);
    release();
    expect((await retried).status).toBe("ready");
    await expect(
      client.createTopic({ ...input, name: "Duplicate" }, "duplicate-request"),
    ).rejects.toMatchObject({ code: "topic-branch-conflict" });
    expect(item.service.snapshot().topics).toHaveLength(1);
    client.close();

    const conflict = await integrationWorld();
    const oldTip = await git(conflict.base, "rev-parse", "main");
    await git(conflict.base, "branch", "collision", "main");
    const conflictClient = await WorkClient.connect(conflict.paths.socket);
    const failed = await conflictClient.createTopic({
      name: "Collision",
      repository: "acme/widgets",
      branch: "collision",
      startPoint: { commit: conflict.commit, sourceCheckout: conflict.source },
    });
    expect(failed).toMatchObject({ status: "failed", code: "start-point-conflict" });
    expect(await git(conflict.base, "rev-parse", "collision")).toBe(oldTip);
    await expect(git(conflict.base, "rev-parse", "collision-2")).rejects.toThrow();
    conflictClient.close();
  });

  test("origin mismatch and a local-only commit in a separate clone fail before Branch creation", async () => {
    const item = await integrationWorld();
    const wrongOrigin = join(item.root, "wrong-origin");
    await git(item.root, "init", "--initial-branch=main", wrongOrigin);
    await git(wrongOrigin, "config", "user.name", "Integration Test");
    await git(wrongOrigin, "config", "user.email", "integration@example.com");
    await git(wrongOrigin, "remote", "add", "origin", "git@github.com:other/widgets.git");
    await writeFile(join(wrongOrigin, "local.txt"), "private\n");
    await git(wrongOrigin, "add", "local.txt");
    await git(wrongOrigin, "commit", "-m", "private");
    await expect(
      resolveTopicCreationInput({
        name: "Mismatch",
        repository: "acme/widgets",
        startPoint: "HEAD",
        sourceCheckout: wrongOrigin,
      }),
    ).rejects.toMatchObject({ code: "repository-mismatch" });

    const separate = join(item.root, "separate-clone");
    await git(item.root, "init", "--initial-branch=main", separate);
    await git(separate, "config", "user.name", "Integration Test");
    await git(separate, "config", "user.email", "integration@example.com");
    await git(separate, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    await writeFile(join(separate, "local.txt"), "local-only\n");
    await git(separate, "add", "local.txt");
    await git(separate, "commit", "-m", "local only");
    const localOnly = await git(separate, "rev-parse", "HEAD");
    const client = await WorkClient.connect(item.paths.socket);
    const failed = await client.createTopic({
      name: "Separate",
      repository: "acme/widgets",
      branch: "separate",
      startPoint: { commit: localOnly, sourceCheckout: separate },
    });
    expect(failed).toMatchObject({ status: "failed", code: "invalid-start-point" });
    await expect(git(item.base, "rev-parse", "separate")).rejects.toThrow();
    client.close();
  });

  test("the documented pi-work package entry points to an executable Bun script", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin?: Record<string, string>;
    };
    const entry = packageJson.bin?.["pi-work"];
    expect(entry).toBe("./agent/extensions/work/client/cli-entry.ts");
    const executable = await stat(entry!);
    expect(executable.mode & 0o111).not.toBe(0);
    expect(await readFile(entry!, "utf8")).toStartWith("#!/usr/bin/env bun\n");
  });
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: testGitEnvironment(cwd),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}
