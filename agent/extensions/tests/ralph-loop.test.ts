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
    await commands.get("ralph-loop")!.handler("start --verify none .scratch/feature/issues:1", ctx);
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

  test("prefers the repo check script for automatic verification", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "ralph-loop-test-"));
    const issueDir = join(repoRoot, ".scratch", "feature", "issues");
    await mkdir(issueDir, { recursive: true });
    await writeFile(join(issueDir, "01-test.md"), "# Test issue\n\nStatus: todo\n", "utf8");
    await writeFile(
      join(repoRoot, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        scripts: {
          check: "pnpm run typecheck && pnpm run test",
          lint: "eslint .",
          test: "vitest",
          typecheck: "tsc --noEmit",
        },
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
      expect(sentMessages[0]).toContain("- pnpm run check");
      expect(sentMessages[0]).not.toContain("- pnpm run test");
      expect(sentMessages[0]).not.toContain("- pnpm run typecheck");
    } finally {
      await commands.get("ralph-loop")?.handler("stop", ctx);
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
