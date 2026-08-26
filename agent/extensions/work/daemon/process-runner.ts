import { spawn } from "node:child_process";

export type ProcessStatus = "completed" | "timeout" | "cancelled";

/** Repository-local Git context that must not leak across checkout processes. */
export const GIT_LOCAL_ENVIRONMENT_VARIABLES = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

export interface ProcessRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  env?: Readonly<Record<string, string>>;
  unsetEnv?: readonly string[];
  signal?: AbortSignal;
}

export interface ProcessResult {
  status: ProcessStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

/** Run one argument-safe process with a deadline and bounded captured output. */
export class LocalProcessRunner implements ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (request.signal?.aborted === true) {
        resolve(emptyResult("cancelled"));
        return;
      }

      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: processEnvironment(request),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let status: ProcessStatus = "completed";
      let settled = false;
      let outputTruncated = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      const capture = (target: Buffer[], chunk: Buffer): void => {
        const remaining = Math.max(0, request.maxOutputBytes - outputBytes);
        if (chunk.byteLength > remaining) outputTruncated = true;
        if (remaining > 0) {
          target.push(chunk.subarray(0, remaining));
          outputBytes += Math.min(chunk.byteLength, remaining);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

      const stop = (nextStatus: ProcessStatus): void => {
        if (settled || status !== "completed") return;
        status = nextStatus;
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => stop("timeout"), request.timeoutMs);
      const onAbort = (): void => stop("cancelled");
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve({
          status,
          exitCode,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          outputTruncated,
        });
      });
    });
  }
}

function processEnvironment(request: ProcessRequest): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...request.env };
  for (const name of request.unsetEnv ?? []) delete environment[name];
  return environment;
}

function emptyResult(status: ProcessStatus): ProcessResult {
  return {
    status,
    exitCode: null,
    stdout: "",
    stderr: "",
    outputTruncated: false,
  };
}
