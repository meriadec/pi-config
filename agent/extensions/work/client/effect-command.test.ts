import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEffectWorkCommand } from "./effect-command.ts";
import { completeWorkBaseSetup, validateWorkBase } from "./work-base-setup.ts";

const temporaryPaths = new Set<string>();

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-work-command-"));
  temporaryPaths.add(path);
  await chmod(path, 0o700);
  return path;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { recursive: true, force: true });
      temporaryPaths.delete(path);
    }),
  );
});

function commandApi() {
  const commands: Array<{
    readonly name: string;
    readonly handler: (args: string, ctx: any) => Promise<void>;
  }> = [];
  const events: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.push({ name, handler: options.handler });
    },
    on(name: string) {
      events.push(name);
    },
  } as unknown as ExtensionAPI;
  return { commands, events, pi };
}

function strictConfiguration(workBase?: string) {
  return {
    version: 2,
    ...(workBase === undefined ? {} : { workBase }),
    policies: {
      defaults: {
        "repository.clone": "deny",
        "topic.create-worktree": "ask",
        "topic.run-setup": "allow",
        "terminal.open": "ask",
        "agent.open": "deny",
        "agent.reset": "allow",
        "topic.delete": "deny",
      },
      repositories: { "LedgerHQ/revault": { "terminal.open": "allow" } },
      topics: {
        "123e4567-e89b-42d3-a456-426614174000": { "topic.delete": "ask" },
      },
    },
    repositories: {
      "LedgerHQ/revault": {
        setupCommands: ["bun install"],
        basePath: "/checkout/revault",
        integrationBranch: "main",
      },
    },
  };
}

describe("/work command", () => {
  test("registers once and rejects non-TUI use before setup", async () => {
    const fixture = commandApi();
    let setupCalls = 0;
    registerEffectWorkCommand(fixture.pi, {
      setup: async () => {
        setupCalls += 1;
        return undefined;
      },
    });
    registerEffectWorkCommand(fixture.pi);

    const notices: string[] = [];
    await fixture.commands[0]!.handler("", {
      mode: "print",
      ui: { notify: (message: string) => notices.push(message) },
    });

    expect(fixture.commands.map(({ name }) => name)).toEqual(["work"]);
    expect(fixture.events).toEqual(["session_shutdown"]);
    expect(notices).toEqual(["/work requires interactive TUI mode."]);
    expect(setupCalls).toBe(0);
  });

  test("cancellation neither connects nor writes configuration", async () => {
    const home = await temporaryDirectory();
    const runtime = await temporaryDirectory();
    const fixture = commandApi();
    let connections = 0;
    registerEffectWorkCommand(fixture.pi, {
      home,
      runtime,
      connect: async () => {
        connections += 1;
        throw new Error("must not connect");
      },
    });

    await fixture.commands[0]!.handler("", {
      mode: "tui",
      ui: {
        input: async () => undefined,
        notify: () => undefined,
      },
    });

    expect(connections).toBe(0);
    expect(await Bun.file(join(home, "work", "config.json")).exists()).toBe(false);
  });

  test("completes first-run setup before trying to connect", async () => {
    const home = await temporaryDirectory();
    const runtime = await temporaryDirectory();
    const workBase = join(home, "projects");
    await mkdir(workBase);
    const fixture = commandApi();
    let connections = 0;
    registerEffectWorkCommand(fixture.pi, {
      home,
      runtime,
      connect: async () => {
        connections += 1;
        throw new Error("connection test stop");
      },
    });

    await fixture.commands[0]!.handler("", {
      mode: "tui",
      ui: {
        input: async () => "~/projects",
        notify: () => undefined,
      },
    });

    expect(connections).toBe(1);
    expect(JSON.parse(await readFile(join(home, "work", "config.json"), "utf8"))).toMatchObject({
      version: 2,
      workBase,
    });
  });
});

describe("first-run Work Base setup", () => {
  test("gives precise validation feedback and retries without writing", async () => {
    const calls: string[] = [];
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    expect(await validateWorkBase("", { home: "/home/test" })).toEqual({
      message: "WORK_BASE is required.",
    });
    expect(await validateWorkBase("relative", { home: "/home/test" })).toEqual({
      message: "WORK_BASE must be an absolute directory path.",
    });
    expect(
      await validateWorkBase("/missing", {
        fileSystem: {
          stat: async () => {
            throw missing;
          },
          access: async () => undefined,
        },
      }),
    ).toEqual({ message: "WORK_BASE does not exist." });
    expect(
      await validateWorkBase("/file", {
        fileSystem: {
          stat: async () => ({ isDirectory: () => false }),
          access: async () => undefined,
        },
      }),
    ).toEqual({ message: "WORK_BASE must be a directory." });
    expect(
      await validateWorkBase("/locked", {
        fileSystem: {
          stat: async () => ({ isDirectory: () => true }),
          access: async (_path, mode) => {
            calls.push(String(mode));
            throw new Error("denied");
          },
        },
      }),
    ).toEqual({ message: "WORK_BASE must be writable." });
    expect(calls).toHaveLength(1);
  });

  test("preserves all strict policy and repository configuration", async () => {
    const home = await temporaryDirectory();
    const root = join(home, "work");
    const configPath = join(root, "config.json");
    const workBase = join(home, "projects");
    await mkdir(root, { mode: 0o700 });
    await mkdir(workBase);
    await writeFile(configPath, `${JSON.stringify(strictConfiguration(), null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(configPath, 0o600);

    const configured = await completeWorkBaseSetup(
      configPath,
      { input: async () => workBase, notify: () => undefined },
      { home },
    );
    const saved = JSON.parse(await readFile(configPath, "utf8"));

    expect(saved).toEqual({ ...strictConfiguration(), workBase });
    expect(configured?.repositories).toEqual(strictConfiguration().repositories);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });
});
