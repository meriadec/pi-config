import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ralphLoopExtension from "../ralph-loop.ts";

const previousAgentConfig = process.env["PI_AGENT_GIT_CONFIG_GLOBAL"];

afterEach(() => {
  if (previousAgentConfig === undefined) delete process.env["PI_AGENT_GIT_CONFIG_GLOBAL"];
  else process.env["PI_AGENT_GIT_CONFIG_GLOBAL"] = previousAgentConfig;
});

describe("ralph-loop git commits", () => {
  test("runs the final commit with the agent git config", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
    const issueDir = join(repoRoot, ".scratch", "feature", "issues");
    await mkdir(issueDir, { recursive: true });
    await writeFile(join(issueDir, "01-test.md"), "# Test issue\n\nStatus: todo\n", "utf8");

    const agentConfig = join(repoRoot, "agent git config");
    process.env["PI_AGENT_GIT_CONFIG_GLOBAL"] = agentConfig;

    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    type RegisteredTool = {
      execute: (
        id: string,
        params: { outcome: string; summary: string; commitMessage: string },
        signal: AbortSignal | undefined,
        onUpdate: () => void,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    let tool: RegisteredTool | undefined;
    const commitInvocations: Array<{ command: string; args: string[] }> = [];
    let statusCalls = 0;

    const pi = {
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, command);
      },
      registerTool(registeredTool: unknown) {
        tool = registeredTool as RegisteredTool;
      },
      async exec(command: string, args: string[]) {
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { stdout: repoRoot, stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("status")) {
          statusCalls += 1;
          return {
            stdout: statusCalls === 1 ? "" : " M changed-file.ts\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (command === "git" && args.includes("--diff-filter=U")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("add")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (command === "bash" && args[0] === "-lc" && args[1]?.includes("git -C")) {
          commitInvocations.push({ command, args });
          return { stdout: "[main abc123] test: commit\n", stderr: "", code: 0, killed: false };
        }
        throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
      },
      appendEntry() {},
      sendUserMessage() {},
      on() {},
    };

    const ctx = {
      cwd: repoRoot,
      ui: {
        setStatus() {},
        notify() {},
      },
      isIdle: () => true,
    };

    ralphLoopExtension(pi as unknown as ExtensionAPI);
    await commands.get("ralph-loop")!.handler("start .scratch/feature/issues:1", ctx);
    await tool!.execute(
      "tool-call",
      { outcome: "completed", summary: "done", commitMessage: "test: commit" },
      undefined,
      () => {},
      ctx,
    );

    expect(commitInvocations).toHaveLength(1);
    expect(commitInvocations[0]!.command).toBe("bash");
    expect(commitInvocations[0]!.args[1]).toContain(`export GIT_CONFIG_GLOBAL='${agentConfig}'`);
    expect(commitInvocations[0]!.args[1]).toContain(
      `git -C '${repoRoot}' commit -m 'test: commit'`,
    );

    await rm(repoRoot, { recursive: true, force: true });
  });

  test("renders a readable pill-based status line", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
    const issueDir = join(repoRoot, ".scratch", "feature", "issues");
    await mkdir(issueDir, { recursive: true });
    await writeFile(join(issueDir, "01-test.md"), "# Test issue\n\nStatus: todo\n", "utf8");

    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const statuses: Array<string | undefined> = [];
    const pi = {
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, command);
      },
      registerTool() {},
      async exec(command: string, args: string[]) {
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { stdout: repoRoot, stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("status")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
      },
      appendEntry() {},
      sendUserMessage() {},
      on() {},
    };

    const ctx = {
      cwd: repoRoot,
      ui: {
        theme: {
          fg(color: string, text: string) {
            return `<fg:${color}>${text}</fg>`;
          },
          bg(color: string, text: string) {
            return `<bg:${color}>${text}</bg>`;
          },
        },
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        notify() {},
      },
      isIdle: () => true,
    };

    try {
      ralphLoopExtension(pi as unknown as ExtensionAPI);
      await commands.get("ralph-loop")!.handler("start .scratch/feature/issues:1", ctx);

      const currentStatus = statuses.at(-1)!;
      expect(currentStatus).toContain(
        "<bg:toolPendingBg><fg:accent> ralph </fg></bg> <fg:accent>running</fg>",
      );
      expect(currentStatus).toContain(
        "<bg:customMessageBg><fg:accent> issue </fg></bg> <fg:text>1</fg>",
      );
      expect(currentStatus).toContain("<bg:selectedBg><fg:muted> try </fg></bg> <fg:text>1/2</fg>");
      expect(currentStatus).toContain(
        "<bg:toolSuccessBg><fg:success> done </fg></bg> <fg:success>0</fg>",
      );
      expect(currentStatus).toContain(
        "<bg:toolPendingBg><fg:warning> skip </fg></bg> <fg:warning>0</fg>",
      );
      expect(currentStatus).toContain("<bg:selectedBg><fg:muted> left </fg></bg> <fg:text>0</fg>");
    } finally {
      await commands.get("ralph-loop")?.handler("stop", ctx);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("prompts the agent to follow repo guidelines and injects no verification commands", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
    const issueDir = join(repoRoot, ".scratch", "feature", "issues");
    await mkdir(issueDir, { recursive: true });
    await writeFile(join(issueDir, "01-test.md"), "# Test issue\n\nStatus: todo\n", "utf8");
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: { test: "vitest", typecheck: "tsc --noEmit" },
      }),
      "utf8",
    );

    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sentMessages: string[] = [];
    const pi = {
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, command);
      },
      registerTool() {},
      async exec(command: string, args: string[]) {
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { stdout: repoRoot, stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("status")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
      },
      appendEntry() {},
      sendUserMessage(message: string) {
        sentMessages.push(message);
      },
      on() {},
    };

    const ctx = {
      cwd: repoRoot,
      ui: {
        setStatus() {},
        notify() {},
      },
      isIdle: () => true,
    };

    try {
      ralphLoopExtension(pi as unknown as ExtensionAPI);
      await commands.get("ralph-loop")!.handler("start .scratch/feature/issues:1", ctx);

      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain("Follow the repo's own contribution guidelines");
      expect(sentMessages[0]).toContain("pre-commit hooks");
      expect(sentMessages[0]).not.toContain("pnpm run");
      expect(sentMessages[0]).not.toContain("Extension verification commands");
    } finally {
      await commands.get("ralph-loop")?.handler("stop", ctx);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test("allows --no-verify after a pre-commit hook rejects the commit", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
    const issueDir = join(repoRoot, ".scratch", "feature", "issues");
    await mkdir(issueDir, { recursive: true });
    await writeFile(join(issueDir, "01-test.md"), "# Test issue\n\nStatus: todo\n", "utf8");

    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    type RegisteredTool = {
      execute: (
        id: string,
        params: { outcome: string; summary: string; commitMessage: string; noVerify?: boolean },
        signal: AbortSignal | undefined,
        onUpdate: () => void,
        ctx: unknown,
      ) => Promise<unknown>;
    };
    let tool: RegisteredTool | undefined;
    const sentMessages: string[] = [];
    let statusCalls = 0;
    let commitCalls = 0;
    const commitScripts: string[] = [];
    const pi = {
      registerCommand(
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) {
        commands.set(name, command);
      },
      registerTool(registeredTool: unknown) {
        tool = registeredTool as RegisteredTool;
      },
      async exec(command: string, args: string[]) {
        if (command === "git" && args.join(" ") === "rev-parse --show-toplevel") {
          return { stdout: repoRoot, stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("status")) {
          statusCalls += 1;
          return {
            stdout: statusCalls === 1 ? "" : " M changed-file.ts\n",
            stderr: "",
            code: 0,
            killed: false,
          };
        }
        if (command === "git" && args.includes("--diff-filter=U")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (command === "git" && args.includes("add")) {
          return { stdout: "", stderr: "", code: 0, killed: false };
        }
        if (command === "bash" && args[0] === "-lc" && args[1]?.includes("git -C")) {
          commitCalls += 1;
          commitScripts.push(args[1]);
          if (commitCalls === 1) {
            return {
              stdout: "",
              stderr: "pre-commit hook failed: typecheck error",
              code: 1,
              killed: false,
            };
          }
          return { stdout: "[main abc123] test: commit\n", stderr: "", code: 0, killed: false };
        }
        throw new Error(`Unexpected exec: ${command} ${args.join(" ")}`);
      },
      appendEntry() {},
      sendUserMessage(message: string) {
        sentMessages.push(message);
      },
      on() {},
    };

    const ctx = {
      cwd: repoRoot,
      ui: {
        setStatus() {},
        notify() {},
      },
      isIdle: () => true,
    };

    try {
      ralphLoopExtension(pi as unknown as ExtensionAPI);
      await commands.get("ralph-loop")!.handler("start .scratch/feature/issues:1", ctx);
      const result = (await tool!.execute(
        "tool-call",
        { outcome: "completed", summary: "done", commitMessage: "test: commit" },
        undefined,
        () => {},
        ctx,
      )) as { content: Array<{ text: string }> };

      expect(commitCalls).toBe(1);
      expect(result.content[0]!.text).toContain("Commit rejected. Queued retry 2/2");
      // A retry prompt with the hook output was sent back to the agent.
      const retryPrompt = sentMessages.at(-1)!;
      expect(retryPrompt).toContain("pre-commit hook");
      expect(retryPrompt).toContain("typecheck error");
      expect(retryPrompt).toContain("noVerify=true");

      const retryResult = (await tool!.execute(
        "tool-call-retry",
        {
          outcome: "completed",
          summary: "Checks pass, but the hook is broken outside this issue.",
          commitMessage: "test: commit",
          noVerify: true,
        },
        undefined,
        () => {},
        ctx,
      )) as { content: Array<{ text: string }> };

      expect(commitCalls).toBe(2);
      expect(commitScripts[0]).not.toContain("--no-verify");
      expect(commitScripts[1]).toContain(
        `git -C '${repoRoot}' commit --no-verify -m 'test: commit'`,
      );
      expect(retryResult.content[0]!.text).toContain("Completed");
    } finally {
      await commands.get("ralph-loop")?.handler("stop", ctx);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
