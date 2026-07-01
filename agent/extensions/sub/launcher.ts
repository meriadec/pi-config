import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface LaunchChildOptions {
  cwd: string;
  jobId: string;
  jobDir: string;
  childSystemPromptPath: string;
  initialPrompt: string;
  forkSessionFile?: string;
}

export async function launchKittyChildPi(options: LaunchChildOptions): Promise<void> {
  const piArgs: string[] = [];
  if (options.forkSessionFile) piArgs.push("--fork", options.forkSessionFile);
  piArgs.push(
    "--append-system-prompt",
    options.childSystemPromptPath,
    "--name",
    `sub ${options.jobId}`,
    options.initialPrompt,
  );

  const piInvocation = getPiInvocation(piArgs);

  const child = spawn(
    "kitty",
    [
      "--single-instance",
      "--instance-group",
      "i3",
      "--hold",
      "env",
      `PI_SUB_JOB_ID=${options.jobId}`,
      `PI_SUB_JOB_DIR=${options.jobDir}`,
      `PI_SUB_PARENT_CWD=${options.cwd}`,
      piInvocation.command,
      ...piInvocation.args,
    ],
    {
      cwd: options.cwd,
      detached: true,
      stdio: "ignore",
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.unref();
      resolve();
    }, 500);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.once("exit", (code) => {
      if (code === 0 || code === null) return;
      clearTimeout(timeout);
      reject(new Error(`kitty exited immediately with code ${code}`));
    });
  });
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}
