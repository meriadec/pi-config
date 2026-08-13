import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore, createTopicStore, createWorkPaths } from "../shared/index.ts";
import type { ActionId, ActionPolicy, TopicManifest } from "../shared/index.ts";
import {
  I3KittyDesktopController,
  mainAgentMark,
  mainAgentShellInvocation,
  mainAgentWindowIdentity,
  selectTopicWorkspace,
  topicMark,
  topicWindowIdentity,
  type DesktopController,
} from "./desktop.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";
import { TopicService } from "./topic-service.ts";

const roots: string[] = [];

class FakeRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly trees: unknown[] = [];
  kittyResult = completed("");
  commandResult = completed("[]");

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    if (request.command === "kitty") return this.kittyResult;
    if (request.args[0] === "-t") return completed(JSON.stringify(this.trees.shift()));
    return this.commandResult;
  }
}

function completed(stdout: string): ProcessResult {
  return {
    status: "completed",
    exitCode: 0,
    stdout,
    stderr: "",
    outputTruncated: false,
  };
}

function root(...workspaces: unknown[]): unknown {
  return { id: 1, type: "root", nodes: workspaces, floating_nodes: [] };
}

function workspace(num: number, nodes: unknown[] = []): unknown {
  return { id: 100 + num, type: "workspace", num, name: String(num), nodes, floating_nodes: [] };
}

function windowNode(id: number, options: { marks?: string[]; identity?: string } = {}): unknown {
  return {
    id,
    type: "con",
    window: 1_000 + id,
    marks: options.marks ?? [],
    nodes: [],
    floating_nodes: [],
    ...(options.identity === undefined
      ? {}
      : { window_properties: { class: options.identity, instance: options.identity } }),
  };
}

describe("i3 workspace selection", () => {
  test("finds an existing marked Topic window at its current tree location", () => {
    const topicId = "opaque/topic id";
    const mark = topicMark(topicId);
    expect(
      selectTopicWorkspace(
        root(workspace(2), workspace(7, [windowNode(3, { marks: [mark] })])),
        topicId,
      ),
    ).toEqual({
      kind: "selected",
      workspace: 7,
    });
    expect(
      selectTopicWorkspace(root(workspace(4, [windowNode(3, { marks: [mark] })])), topicId),
    ).toEqual({
      kind: "selected",
      workspace: 4,
    });
  });

  test("anchors to the Main Agent window after the marked terminal closes", () => {
    const topicId = "topic";
    // The terminal that carried topicMark is gone; only the Main Agent window
    // remains, identified by its mainAgentMark and durable window identity.
    expect(
      selectTopicWorkspace(
        root(
          workspace(1),
          workspace(6, [
            windowNode(9, {
              marks: [mainAgentMark(topicId)],
              identity: mainAgentWindowIdentity(topicId),
            }),
          ]),
        ),
        topicId,
      ),
    ).toEqual({ kind: "selected", workspace: 6 });
    // A Topic terminal that lost its unique mark is still found by identity.
    expect(
      selectTopicWorkspace(
        root(
          workspace(1),
          workspace(5, [windowNode(8, { identity: topicWindowIdentity(topicId) })]),
        ),
        topicId,
      ),
    ).toEqual({ kind: "selected", workspace: 5 });
  });

  test("keeps the Main Agent workspace authoritative when a terminal lingers elsewhere", () => {
    const topicId = "topic";
    // The Main Agent anchors workspace 5; a leftover terminal on workspace 2
    // must not turn the layout ambiguous.
    expect(
      selectTopicWorkspace(
        root(
          workspace(2, [windowNode(20, { identity: topicWindowIdentity(topicId) })]),
          workspace(5, [windowNode(50, { marks: [mainAgentMark(topicId)] })]),
        ),
        topicId,
      ),
    ).toEqual({ kind: "selected", workspace: 5 });
  });

  test("selects the lowest empty or unmaterialized workspace in 1 through 10", () => {
    const topicId = "topic";
    expect(
      selectTopicWorkspace(
        root(workspace(1, [windowNode(1, { marks: ["unrelated"] })]), workspace(2)),
        topicId,
      ),
    ).toEqual({ kind: "selected", workspace: 2 });
    expect(
      selectTopicWorkspace(root(workspace(1, [windowNode(1)]), workspace(3)), topicId),
    ).toEqual({
      kind: "selected",
      workspace: 2,
    });
  });

  test("returns unavailable as data when the pool is full", () => {
    const tree = root(
      ...Array.from({ length: 10 }, (_, index) => workspace(index + 1, [windowNode(index + 1)])),
    );
    expect(selectTopicWorkspace(tree, "topic")).toMatchObject({ kind: "unavailable" });
  });
});

describe("marked Kitty launch", () => {
  test("uses bounded argument-safe commands, cwd, identity, and a specific container", async () => {
    const runner = new FakeRunner();
    const topicId = "opaque id with command punctuation; [x]";
    const identity = topicWindowIdentity(topicId);
    runner.trees.push(
      root(workspace(1, [windowNode(10, { marks: ["keep-me"] })]), workspace(2)),
      root(
        workspace(1, [windowNode(10, { marks: ["keep-me"] })]),
        workspace(2, [windowNode(20, { identity })]),
      ),
    );
    const desktop = new I3KittyDesktopController({ runner, sleep: async () => undefined });

    expect(await desktop.openTerminal(topicId, "/tmp/topic worktree")).toEqual({
      kind: "launched",
      workspace: 2,
      message: "Opened Topic terminal on workspace 2.",
    });
    const kitty = runner.requests.find((request) => request.command === "kitty")!;
    expect(kitty.args).toEqual([
      "--single-instance",
      "--instance-group",
      "i3",
      "--detach",
      "--class",
      identity,
      "--name",
      identity,
      "--directory",
      "/tmp/topic worktree",
    ]);
    expect(kitty.cwd).toBe("/tmp/topic worktree");
    expect(kitty.timeoutMs).toBe(2_000);
    expect(kitty.maxOutputBytes).toBe(64 * 1024);
    expect(runner.requests.at(-1)?.args).toEqual([
      `[con_id=20] move container to workspace number 2, mark --add ${topicMark(topicId)}`,
    ]);
    expect(runner.requests.some((request) => request.args.join(" ").includes("keep-me"))).toBe(
      false,
    );
  });

  test("puts later Topic terminals on the marked workspace", async () => {
    const runner = new FakeRunner();
    const topicId = "topic";
    const identity = topicWindowIdentity(topicId);
    runner.trees.push(
      root(workspace(3, [windowNode(10, { marks: [topicMark(topicId)], identity })])),
      root(
        workspace(3, [
          windowNode(10, { marks: [topicMark(topicId)], identity }),
          windowNode(11, { identity }),
        ]),
      ),
    );
    const desktop = new I3KittyDesktopController({ runner });
    expect(await desktop.openTerminal(topicId, "/tmp/worktree")).toMatchObject({
      kind: "launched",
      workspace: 3,
    });
    expect(runner.requests.at(-1)?.args[0]).toContain("[con_id=11]");
  });

  test("launches a resumable Main Agent with explicit identity and environment", async () => {
    const runner = new FakeRunner();
    const topicId = "123e4567-e89b-42d3-a456-426614174000";
    const identity = mainAgentWindowIdentity(topicId);
    runner.trees.push(root(workspace(1)), root(workspace(1, [windowNode(30, { identity })])));
    const desktop = new I3KittyDesktopController({
      runner,
      nodeCommand: "/test/bin/node",
      piCommand: "/test/bin/pi",
      shellCommand: "/test/bin/shell",
    });
    expect(
      await desktop.openMainAgent({
        topicId,
        topicName: "VG-123",
        worktreePath: "/tmp/worktree",
        sessionId: topicId,
        socketPath: "/run/user/1000/pi-workd.sock",
        registrationToken: "one-launch-token",
        affiliationToken: "one-window-affiliation",
      }),
    ).toMatchObject({ kind: "launched", workspace: 1 });
    const kitty = runner.requests.find((request) => request.command === "kitty")!;
    expect(kitty.args).toEqual([
      "--single-instance",
      "--instance-group",
      "i3",
      "--detach",
      "--class",
      identity,
      "--name",
      identity,
      "--directory",
      "/tmp/worktree",
      "/test/bin/shell",
      "-i",
      "-c",
      "'/test/bin/node' '/test/bin/pi' '--session-id' '123e4567-e89b-42d3-a456-426614174000' '--name' 'Work: VG-123'\n:",
    ]);
    expect(kitty.env).toEqual({
      PI_WORK_TOPIC_ID: topicId,
      PI_WORK_SOCKET: "/run/user/1000/pi-workd.sock",
      PI_WORK_REGISTRATION_TOKEN: "one-launch-token",
      PI_WORK_SESSION_ID: topicId,
      PI_WORK_AFFILIATION: "one-window-affiliation",
      PI_WORK_TOPIC_NAME: "VG-123",
    });
    expect(runner.requests.at(-1)?.args[0]).toContain(`mark --add ${mainAgentMark(topicId)}`);
  });

  test("launches a job-control zsh Main Agent from a private startup file", async () => {
    const runner = new FakeRunner();
    const topicId = "123e4567-e89b-42d3-a456-426614174000";
    const identity = mainAgentWindowIdentity(topicId);
    runner.trees.push(root(workspace(1)), root(workspace(1, [windowNode(30, { identity })])));
    const written: Array<{ path: string; content: string }> = [];
    const desktop = new I3KittyDesktopController({
      runner,
      piCommand: "/test/bin/pi",
      shellCommand: "/usr/bin/zsh",
      runtimeDir: "/run/user/1000",
      writeRcFile: async (path, content) => {
        written.push({ path, content });
      },
    });
    expect(
      await desktop.openMainAgent({
        topicId,
        topicName: "VG-123",
        worktreePath: "/tmp/worktree",
        sessionId: topicId,
        socketPath: "/run/user/1000/pi-workd.sock",
        registrationToken: "one-launch-token",
        affiliationToken: "one-window-affiliation",
      }),
    ).toMatchObject({ kind: "launched", workspace: 1 });
    const kitty = runner.requests.find((request) => request.command === "kitty")!;
    // No `-c` command source, so a Ctrl-Z suspend drops to an interactive prompt.
    expect(kitty.args.slice(-2)).toEqual(["/usr/bin/zsh", "-i"]);
    expect(kitty.args).not.toContain("-c");
    expect(kitty.env?.["ZDOTDIR"]).toBe(written[0]!.path.replace(/\/\.zshrc$/, ""));
    expect(kitty.env?.["PI_WORK_TOPIC_ID"]).toBe(topicId);
    // The startup file loads user aliases, then runs Pi as a foreground job.
    expect(written).toHaveLength(1);
    expect(written[0]!.path.endsWith("/.zshrc")).toBe(true);
    expect(written[0]!.content).toContain('source "$HOME/.zshrc"');
    expect(written[0]!.content).toContain("'/test/bin/pi' '--session-id'");
    expect(written[0]!.content).not.toContain("\n:\n");
  });

  test("focuses an existing marked Main Agent instead of launching another", async () => {
    const runner = new FakeRunner();
    const topicId = "topic";
    runner.trees.push(root(workspace(4, [windowNode(40, { marks: [mainAgentMark(topicId)] })])));
    const desktop = new I3KittyDesktopController({ runner });
    expect(
      await desktop.openMainAgent({
        topicId,
        topicName: "Topic",
        worktreePath: "/tmp/worktree",
        sessionId: "session",
        socketPath: "/tmp/socket",
        registrationToken: "token",
        affiliationToken: "affiliation",
      }),
    ).toEqual({ kind: "focused", workspace: 4, message: "Focused Main Agent on workspace 4." });
    expect(runner.requests.some((request) => request.command === "kitty")).toBe(false);
    expect(runner.requests.at(-1)?.args).toEqual(["[con_id=40] focus"]);
  });

  test("closes exactly one marked Main Agent before reset", async () => {
    const runner = new FakeRunner();
    const topicId = "topic";
    runner.trees.push(root(workspace(4, [windowNode(40, { marks: [mainAgentMark(topicId)] })])));
    const desktop = new I3KittyDesktopController({ runner });

    expect(await desktop.closeMainAgent(topicId)).toEqual({
      kind: "closed",
      message: "Closed the previous Main Agent window.",
    });
    expect(runner.requests.at(-1)?.args).toEqual(["[con_id=40] kill"]);
  });

  test("does not mark windows after identity timeout or ambiguous matches", async () => {
    let now = 0;
    const timeoutRunner = new FakeRunner();
    timeoutRunner.trees.push(root(workspace(1)), root(workspace(1)), root(workspace(1)));
    const timeoutDesktop = new I3KittyDesktopController({
      runner: timeoutRunner,
      now: () => now,
      sleep: async () => {
        now += 5;
      },
      reconcileTimeoutMs: 5,
      pollIntervalMs: 5,
    });
    expect(await timeoutDesktop.openTerminal("timeout", "/tmp/worktree")).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("Timed out"),
    });
    expect(timeoutRunner.requests.some((request) => request.args[0]?.includes("mark --add"))).toBe(
      false,
    );

    const ambiguousRunner = new FakeRunner();
    const identity = topicWindowIdentity("ambiguous");
    ambiguousRunner.trees.push(
      root(workspace(1)),
      root(workspace(1, [windowNode(2, { identity }), windowNode(3, { identity })])),
    );
    const ambiguousDesktop = new I3KittyDesktopController({ runner: ambiguousRunner });
    expect(await ambiguousDesktop.openTerminal("ambiguous", "/tmp/worktree")).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("ambiguous"),
    });
    expect(
      ambiguousRunner.requests.some((request) => request.args[0]?.includes("mark --add")),
    ).toBe(false);
  });

  test("anchors workspace access on the Main Agent window even across split workspaces", async () => {
    const runner = new FakeRunner();
    const topicId = "topic";
    // A leftover terminal carries the Topic identity on workspace 2 while the
    // Main Agent sits on workspace 5. selectTopicWorkspace must still land on
    // the Main Agent's workspace instead of calling the split layout ambiguous.
    runner.trees.push(
      root(
        workspace(2, [windowNode(20, { identity: topicWindowIdentity(topicId) })]),
        workspace(5, [windowNode(50, { marks: [mainAgentMark(topicId)] })]),
      ),
    );
    const desktop = new I3KittyDesktopController({ runner });
    expect(await desktop.accessWorkspace(topicId)).toEqual({
      kind: "focused",
      workspace: 5,
      message: "Focused Topic workspace 5.",
    });
    expect(runner.requests.at(-1)?.args).toEqual(["workspace number 5"]);
  });

  test("reports bounded process timeout and output failures", async () => {
    const timeout = new FakeRunner();
    timeout.commandResult = { ...completed(""), status: "timeout", exitCode: null };
    timeout.trees.push(root(workspace(1)));
    await expect(
      new I3KittyDesktopController({ runner: timeout }).accessWorkspace("topic"),
    ).rejects.toMatchObject({
      code: "desktop-timeout",
    });

    const oversized = new FakeRunner();
    oversized.run = async (request) => {
      oversized.requests.push(request);
      return { ...completed("{}"), outputTruncated: true };
    };
    await expect(
      new I3KittyDesktopController({ runner: oversized }).accessWorkspace("topic"),
    ).rejects.toMatchObject({
      code: "desktop-output-too-large",
    });
  });
});

describe("daemon terminal rules", () => {
  test("exposes workspace and terminal actions as semantic events", async () => {
    const world = await serviceWorld("allow", true);
    const eventTypes: string[] = [];
    world.service.subscribe((event) => eventTypes.push(event.type));
    expect(await world.service.accessWorkspace("client", "access", world.topic.id)).toMatchObject({
      kind: "focused",
    });
    expect(await world.service.openTerminal("client", "open", world.topic.id)).toMatchObject({
      kind: "launched",
    });
    expect(eventTypes).toContain("workspace-accessed");
    expect(eventTypes).toContain("terminal-opened");
  });

  test("enforces deny and ask policy and rejects a non-ready Topic", async () => {
    const deny = await serviceWorld("deny", true);
    expect(await deny.service.openTerminal("client", "deny", deny.topic.id)).toMatchObject({
      status: "denied",
    });
    expect(deny.desktop.opens).toBe(0);

    const ask = await serviceWorld("ask", true);
    const requirement = await ask.service.openTerminal("client", "ask", ask.topic.id);
    expect(requirement).toMatchObject({ status: "confirmation-required", action: "terminal.open" });
    if (!("status" in requirement) || requirement.status !== "confirmation-required")
      throw new Error("expected confirmation");
    expect(await ask.service.confirm("client", "confirm", requirement.token)).toMatchObject({
      kind: "launched",
    });
    expect(ask.desktop.opens).toBe(1);

    const unfinished = await serviceWorld("allow", false);
    await expect(
      unfinished.service.openTerminal("client", "open", unfinished.topic.id),
    ).rejects.toMatchObject({
      code: "invalid-topic-state",
    });
    expect(unfinished.desktop.opens).toBe(0);
  });
});

class FakeDesktop implements DesktopController {
  opens = 0;
  async accessWorkspace() {
    return { kind: "focused" as const, workspace: 1, message: "Focused." };
  }
  async openTerminal() {
    this.opens += 1;
    return { kind: "launched" as const, workspace: 1, message: "Opened." };
  }
}

async function serviceWorld(policy: ActionPolicy, ready: boolean) {
  const rootPath = await mkdtemp(join(tmpdir(), "work-desktop-policy-"));
  roots.push(rootPath);
  const runtime = join(rootPath, "runtime");
  const paths = createWorkPaths({ home: join(rootPath, "home"), runtime });
  await mkdir(runtime, { recursive: true });
  const config = createConfigStore(paths);
  const defaults = Object.fromEntries(
    (
      [
        "repository.clone",
        "topic.create-worktree",
        "terminal.open",
        "agent.open",
        "topic.delete",
      ] as ActionId[]
    ).map((action) => [action, action === "terminal.open" ? policy : "allow"]),
  );
  await config.save({
    version: 1,
    workBase: rootPath,
    policies: { defaults, repositories: {}, topics: {} },
  });
  const topics = createTopicStore(paths);
  let topic = await topics.create({ name: "Topic", branch: "topic", repository: "owner/repo" });
  if (ready) {
    topic = await topics.update(topic.id, (current) => ({
      ...current,
      setup: { state: "ready", repositoryAvailable: true, worktreeCreated: true },
      worktreePath: join(rootPath, "worktree"),
    }));
  }
  const desktop = new FakeDesktop();
  const service = new TopicService({
    config,
    topics,
    desktop,
    provisioner: {
      provision: async () => {
        throw new Error("not used");
      },
    },
  });
  await service.start();
  return { service, desktop, topic: topic as TopicManifest };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("mainAgentShellInvocation", () => {
  const base = {
    runtimeDir: "/run/user/1000",
    topicId: "123e4567-e89b-42d3-a456-426614174000",
    nodeCommand: undefined,
    piCommand: "/test/bin/pi",
    sessionId: "session",
    topicName: "VG-123",
  };

  test("zsh runs Pi from ZDOTDIR so a suspend keeps an interactive prompt", () => {
    const invocation = mainAgentShellInvocation({ ...base, shellPath: "/usr/bin/zsh" });
    expect(invocation.args).toEqual(["/usr/bin/zsh", "-i"]);
    expect(invocation.args).not.toContain("-c");
    expect(invocation.env["ZDOTDIR"]).toBe(invocation.rcFile?.path.replace(/\/\.zshrc$/, ""));
    expect(invocation.rcFile?.path.endsWith("/.zshrc")).toBe(true);
    expect(invocation.rcFile?.content).toContain('source "$HOME/.zshrc"');
    expect(invocation.rcFile?.content).toContain("'/test/bin/pi' '--session-id' 'session'");
  });

  test("bash runs Pi from an interactive rcfile", () => {
    const invocation = mainAgentShellInvocation({ ...base, shellPath: "/bin/bash" });
    expect(invocation.args[0]).toBe("/bin/bash");
    expect(invocation.args).toContain("--rcfile");
    expect(invocation.args).toContain("-i");
    expect(invocation.args).not.toContain("-c");
    expect(invocation.env).toEqual({});
    expect(invocation.rcFile?.content).toContain('source "$HOME/.bashrc"');
  });

  test("unknown shell keeps the legacy -c launch without a startup file", () => {
    const invocation = mainAgentShellInvocation({ ...base, shellPath: "/bin/dash" });
    expect(invocation.args[0]).toBe("/bin/dash");
    expect(invocation.args).toEqual([
      "/bin/dash",
      "-i",
      "-c",
      "'/test/bin/pi' '--session-id' 'session' '--name' 'Work: VG-123'\n:",
    ]);
    expect(invocation.rcFile).toBeUndefined();
  });
});
