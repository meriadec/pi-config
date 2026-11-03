import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { applyEventLine, buildChildEnvironment, type ChildResult } from "./core.ts";

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", args };
  return { command: process.execPath, args };
}

/**
 * Runs one headless child `pi` and streams its events into `result`.
 * Calls `onChange` after each change. Never rejects: failures set `exitCode` and `stderr`.
 */
export async function runChild(
  result: ChildResult,
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  onChange: () => void,
): Promise<void> {
  const invocation = getPiInvocation(args);
  result.exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnvironment(),
    });
    let buffer = "";
    const handleLine = (line: string) => {
      if (applyEventLine(result, line)) onChange();
    };

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
    proc.stderr.on("data", (data: Buffer) => {
      result.stderr += data.toString();
    });
    proc.on("close", (code) => {
      handleLine(buffer);
      resolve(signal?.aborted ? 130 : (code ?? 0));
    });
    proc.on("error", (error) => {
      result.stderr += String(error);
      resolve(1);
    });

    if (signal) {
      const kill = () => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (proc.exitCode === null) proc.kill("SIGKILL");
        }, 5000).unref();
      };
      if (signal.aborted) kill();
      else signal.addEventListener("abort", kill, { once: true });
    }
  });
  if (signal?.aborted) result.stopReason = "aborted";
}
