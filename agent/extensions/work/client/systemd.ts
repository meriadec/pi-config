import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundMessage } from "../shared/domain.ts";
import { WorkClient } from "./client.ts";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (command: string, args: readonly string[]) => Promise<ProcessResult>;

export interface SystemdPaths {
  unitPath: string;
  bunExecutable: string;
  nodeExecutable: string;
  piExecutable: string;
  daemonEntryPath: string;
  socketPath: string;
}

export interface SystemdManagerOptions {
  paths: SystemdPaths;
  run?: ProcessRunner;
  connect?: (socketPath: string, timeoutMs: number) => Promise<WorkClient>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  attemptTimeoutMs?: number;
  clientId?: string;
}

export interface InstallResult {
  changed: boolean;
}

export function defaultSystemdPaths(
  home: string,
  socketPath: string,
  environment: NodeJS.ProcessEnv = process.env,
): SystemdPaths {
  return {
    unitPath: join(home, ".config", "systemd", "user", "pi-workd.service"),
    bunExecutable: findBunExecutable(home, environment),
    nodeExecutable: findNodeExecutable(environment),
    piExecutable: findPiExecutable(home, environment),
    daemonEntryPath: fileURLToPath(new URL("../daemon/entry.ts", import.meta.url)),
    socketPath,
  };
}

export function findBunExecutable(home: string, environment: NodeJS.ProcessEnv): string {
  return findExecutable("bun", environment, [
    ...(environment["BUN_INSTALL"] === undefined
      ? []
      : [join(environment["BUN_INSTALL"], "bin", "bun")]),
    join(home, ".bun", "bin", "bun"),
  ]);
}

export function findNodeExecutable(environment: NodeJS.ProcessEnv): string {
  return findExecutable("node", environment, [process.execPath]);
}

export function findPiExecutable(home: string, environment: NodeJS.ProcessEnv): string {
  return findExecutable("pi", environment, [join(home, ".bun", "bin", "pi")]);
}

function findExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  fallbacks: readonly string[],
): string {
  const candidates = [
    ...(environment["PATH"] ?? "")
      .split(delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => join(directory, name)),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Try the next configured location.
    }
  }
  return resolve(fallbacks[0] ?? name);
}

export function generateSystemdUnit(paths: SystemdPaths): string {
  return [
    "[Unit]",
    "Description=Pi work control-plane daemon",
    "",
    "[Service]",
    "Type=simple",
    `Environment=${systemdQuote(`PI_WORK_NODE_EXECUTABLE=${resolve(paths.nodeExecutable)}`)}`,
    `Environment=${systemdQuote(`PI_WORK_PI_EXECUTABLE=${resolve(paths.piExecutable)}`)}`,
    `ExecStart=${systemdQuote(resolve(paths.bunExecutable))} ${systemdQuote(resolve(paths.daemonEntryPath))}`,
    "Restart=on-failure",
    "RestartSec=1s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export class SystemdWorkdManager {
  private readonly run: ProcessRunner;
  private readonly connectClient: (socketPath: string, timeoutMs: number) => Promise<WorkClient>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly options: SystemdManagerOptions;

  constructor(options: SystemdManagerOptions) {
    this.options = options;
    this.run = options.run ?? runProcess;
    this.connectClient =
      options.connect ??
      ((socketPath, timeoutMs) =>
        WorkClient.connect(socketPath, {
          timeoutMs,
          ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
        }));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
  }

  async install(): Promise<InstallResult> {
    const content = generateSystemdUnit(this.options.paths);
    let current: string | undefined;
    try {
      current = await readFile(this.options.paths.unitPath, "utf8");
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    if (current === content) return { changed: false };

    const unitPath = this.options.paths.unitPath;
    await mkdir(dirname(unitPath), { recursive: true, mode: 0o700 });
    const temporary = `${unitPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await chmod(temporary, 0o600);
      await rename(temporary, unitPath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    await this.systemctl(["daemon-reload"], "reload the systemd user manager");
    return { changed: true };
  }

  async ensureConnected(): Promise<WorkClient> {
    const attemptTimeout = this.options.attemptTimeoutMs ?? 300;
    const existing = await this.tryConnected(attemptTimeout);
    if (existing !== undefined) return existing;

    await this.install();
    // A failed ping can mean that an older daemon still owns the socket.
    // Restart also starts an inactive unit and always loads the current extension code.
    await this.systemctl(["restart", "pi-workd.service"], "restart pi-workd");

    const deadline = this.now() + (this.options.startupTimeoutMs ?? 5_000);
    let lastError = "daemon did not accept a connection";
    while (this.now() < deadline) {
      const client = await this.tryConnected(attemptTimeout, (message) => {
        lastError = message;
      });
      if (client !== undefined) return client;
      const remaining = deadline - this.now();
      if (remaining > 0) await this.sleep(Math.min(100, remaining));
    }
    throw new Error(boundMessage(`Timed out while starting pi-workd: ${lastError}.`));
  }

  private async tryConnected(
    timeoutMs: number,
    onError?: (message: string) => void,
  ): Promise<WorkClient | undefined> {
    let client: WorkClient | undefined;
    try {
      client = await this.connectClient(this.options.paths.socketPath, timeoutMs);
      await client.ping(timeoutMs);
      return client;
    } catch (error) {
      client?.close();
      onError?.(error instanceof Error ? error.message : "unknown connection error");
      return undefined;
    }
  }

  private async systemctl(args: readonly string[], action: string): Promise<void> {
    const result = await this.run("systemctl", ["--user", ...args]);
    if (result.code !== 0) {
      const reason = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
      throw new Error(boundMessage(`Could not ${action}: ${reason}`));
    }
  }
}

export const runProcess: ProcessRunner = (command, args) =>
  new Promise((resolveResult) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 5_000);
    const finish = (result: ProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    child.once("error", (error) => {
      finish({ code: 127, stdout, stderr: boundMessage(error.message) });
    });
    child.once("close", (code) => {
      finish({
        code: timedOut ? 124 : (code ?? 1),
        stdout,
        stderr: timedOut ? "systemctl timed out after 5 seconds" : stderr,
      });
    });
  });

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function systemdQuote(value: string): string {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("Systemd service argument contains an unsafe character.");
  }
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function appendBounded(current: string, chunk: string): string {
  const maximum = 8 * 1024;
  if (current.length >= maximum) return current;
  return boundOutput(current + chunk);
}

function boundOutput(value: string): string {
  const maximum = 8 * 1024;
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
