import { runProcessPromise } from "../infrastructure/process/process-executor.ts";
import { accessSync, constants } from "node:fs";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientId, WORK_PROTOCOL_VERSION, WORK_STORAGE_SCHEMA_VERSION } from "../domain/index.ts";
import type { Compatibility } from "../infrastructure/rpc/index.ts";
import { makeWorkClientRuntime, type WorkClientRuntime } from "./effect-runtime.ts";

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
  ghExecutable: string;
  daemonEntryPath: string;
  socketPath: string;
}

export interface SystemdCompatibleClient {
  readonly compatibility: () => Promise<Compatibility>;
  readonly close?: () => void;
  readonly dispose?: () => Promise<void>;
}

export interface SystemdManagerOptions<Client extends SystemdCompatibleClient = WorkClientRuntime> {
  paths: SystemdPaths;
  run?: ProcessRunner;
  connect?: (socketPath: string, timeoutMs: number) => Promise<Client>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  startupTimeoutMs?: number;
  attemptTimeoutMs?: number;
  clientId?: string;
  environment?: NodeJS.ProcessEnv;
}

// The daemon inherits the systemd user manager environment, not the client
// shell. Forward these GitHub credentials so daemon-side gh (pull request
// discovery and gh clone) authenticates the same way the client shell does.
const FORWARDED_CREDENTIALS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

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
    ghExecutable: findGhExecutable(environment),
    daemonEntryPath: fileURLToPath(new URL("../daemon/effect-entry.ts", import.meta.url)),
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

// The daemon inherits the minimal systemd user PATH, so resolve gh from the
// richer client environment (mise, Homebrew, and similar) and pass its absolute
// path. Otherwise pull request discovery and gh-based cloning cannot find gh.
export function findGhExecutable(environment: NodeJS.ProcessEnv): string {
  return findExecutable("gh", environment, ["gh"]);
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
    "UMask=0077",
    `Environment=${systemdQuote(`PI_WORK_SOCKET=${resolve(paths.socketPath)}`)}`,
    `Environment=${systemdQuote(`PI_WORK_NODE_EXECUTABLE=${resolve(paths.nodeExecutable)}`)}`,
    `Environment=${systemdQuote(`PI_WORK_PI_EXECUTABLE=${resolve(paths.piExecutable)}`)}`,
    `Environment=${systemdQuote(`PI_WORK_GH_EXECUTABLE=${resolve(paths.ghExecutable)}`)}`,
    `ExecStart=${systemdQuote(resolve(paths.bunExecutable))} ${systemdQuote(resolve(paths.daemonEntryPath))}`,
    "Restart=on-failure",
    "RestartSec=1s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export class SystemdWorkdManager<Client extends SystemdCompatibleClient = WorkClientRuntime> {
  private readonly run: ProcessRunner;
  private readonly connectClient: (socketPath: string, timeoutMs: number) => Promise<Client>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly options: SystemdManagerOptions<Client>;

  constructor(options: SystemdManagerOptions<Client>) {
    this.options = options;
    this.run = options.run ?? runProcess;
    this.connectClient =
      options.connect ??
      (((socketPath: string) =>
        Promise.resolve(
          makeWorkClientRuntime({
            socketPath,
            ...(options.clientId === undefined
              ? {}
              : { clientId: ClientId.make(options.clientId) }),
          }),
        )) as unknown as (socketPath: string, timeoutMs: number) => Promise<Client>);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.environment = options.environment ?? process.env;
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

  async ensureConnected(): Promise<Client> {
    const attemptTimeout = this.options.attemptTimeoutMs ?? 300;
    const existing = await this.tryConnected(attemptTimeout);
    if (existing !== undefined) return existing;

    await this.install();
    // A failed ping can mean that an older daemon still owns the socket.
    // Restart also starts an inactive unit and always loads the current extension code.
    await this.forwardCredentials();
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
  ): Promise<Client | undefined> {
    let client: Client | undefined;
    try {
      client = await this.connectClient(this.options.paths.socketPath, timeoutMs);
      const compatibility = await withTimeout(
        client.compatibility(),
        timeoutMs,
        "Work daemon compatibility handshake timed out.",
      );
      if (
        compatibility.applicationProtocol !== WORK_PROTOCOL_VERSION ||
        compatibility.storageSchema !== WORK_STORAGE_SCHEMA_VERSION
      ) {
        throw new Error(
          `Incompatible Work daemon (protocol ${compatibility.applicationProtocol}, storage ${compatibility.storageSchema}).`,
        );
      }
      if (compatibility.state !== "ready") {
        throw new Error(`Work daemon is ${compatibility.state}.`);
      }
      return client;
    } catch (error) {
      await closeSystemdClient(client);
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

  // Copy the credential values from the client shell into the systemd user
  // manager environment, by name, so the next daemon start inherits them. The
  // values never reach a command line and are not written to disk. Forwarding
  // is best effort: a failure must not stop the daemon from starting.
  private async forwardCredentials(): Promise<void> {
    const names = FORWARDED_CREDENTIALS.filter((name) => {
      const value = this.environment[name];
      return typeof value === "string" && value.length > 0;
    });
    if (names.length === 0) return;
    try {
      await this.systemctl(["import-environment", ...names], "forward GitHub credentials");
    } catch {
      // The daemon can still start; only gh-authenticated features degrade.
    }
  }
}

async function closeSystemdClient(client: SystemdCompatibleClient | undefined): Promise<void> {
  if (client?.close !== undefined) client.close();
  else await client?.dispose?.();
}

function withTimeout<A>(promise: Promise<A>, timeoutMs: number, message: string): Promise<A> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export const runProcess: ProcessRunner = async (command, args) => {
  try {
    const result = await runProcessPromise({
      command: { _tag: "Executable", executable: command, arguments: args },
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 8 * 1024,
    });
    return {
      code: result.status === "timeout" ? 124 : (result.exitCode ?? 1),
      stdout: result.stdout,
      stderr: result.status === "timeout" ? "systemctl timed out after 5 seconds" : result.stderr,
    };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: boundMessage(error instanceof Error ? error.message : "The process could not start."),
    };
  }
};

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function systemdQuote(value: string): string {
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    throw new Error("Systemd service argument contains an unsafe character.");
  }
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function boundMessage(message: string): string {
  const oneLine = message.replaceAll(/\s+/g, " ").trim();
  return oneLine.length <= 200 ? oneLine : `${oneLine.slice(0, 199)}…`;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
