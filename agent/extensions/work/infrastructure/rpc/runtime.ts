import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { chmod, lstat, open, readFile, rm } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { RpcFailure } from "../../domain/index.ts";

export const PRIVATE_SOCKET_MODE = 0o600;
export const PRIVATE_LOCK_MODE = 0o600;

export interface DaemonRuntimeLease {
  readonly runtimeDirectory: string;
  readonly socketPath: string;
  readonly lockPath: string;
}

export interface DaemonRuntimeOptions {
  readonly runtimeDirectory: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly listenerProbeTimeoutMs?: number;
}

/**
 * Acquires the lifetime singleton before the caller constructs storage or application services.
 * The lock is the singleton guard. A stale socket is only cleanup after ownership and type checks.
 */
export function acquireDaemonRuntime(
  options: DaemonRuntimeOptions,
): Effect.Effect<DaemonRuntimeLease, RpcFailure, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        validateLocations(options);
        const directory = await lstat(options.runtimeDirectory);
        if (
          !directory.isDirectory() ||
          directory.uid !== currentUserId() ||
          (directory.mode & 0o077) !== 0
        ) {
          throw new Error("The runtime directory is not a private directory owned by this user.");
        }

        const lock = await acquireLifetimeLock(options);
        try {
          await validateAndRemoveStaleSocket(
            options.socketPath,
            options.listenerProbeTimeoutMs ?? 250,
          );
          return {
            lease: {
              runtimeDirectory: options.runtimeDirectory,
              socketPath: options.socketPath,
              lockPath: options.lockPath,
            },
            lock,
          };
        } catch (cause) {
          await lock.close();
          await rm(options.lockPath, { force: true });
          throw cause;
        }
      },
      catch: (cause) =>
        new RpcFailure({
          reason: "unavailable",
          message: publicStartupMessage(cause),
          internalCause: cause,
        }),
    }),
    ({ lock, lease }) =>
      Effect.promise(async () => {
        await lock.close().catch(() => undefined);
        await rm(lease.socketPath, { force: true }).catch(() => undefined);
        await rm(lease.lockPath, { force: true }).catch(() => undefined);
      }),
  ).pipe(Effect.map(({ lease }) => lease));
}

/** Call only after the Effect socket server has bound the path. */
export const secureBoundSocket = (socketPath: string): Effect.Effect<void, RpcFailure> =>
  Effect.tryPromise({
    try: () => chmod(socketPath, PRIVATE_SOCKET_MODE),
    catch: (cause) =>
      new RpcFailure({
        reason: "unavailable",
        message: "The Work daemon socket permissions could not be secured.",
        internalCause: cause,
      }),
  });

function validateLocations(options: DaemonRuntimeOptions): void {
  const runtime = resolve(options.runtimeDirectory);
  if (
    dirname(resolve(options.socketPath)) !== runtime ||
    dirname(resolve(options.lockPath)) !== runtime
  ) {
    throw new Error("The Work daemon socket and lock must be directly in the runtime directory.");
  }
}

const LEGACY_LOCK_STALE_AGE_MS = 5_000;

async function acquireLifetimeLock(options: DaemonRuntimeOptions) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(options.lockPath, "wx", PRIVATE_LOCK_MODE);
      await lock.writeFile(`${process.pid}\n`);
      await lock.sync();
      return lock;
    } catch (cause) {
      if (attempt === 0 && isNodeError(cause, "EEXIST") && (await isStaleLifetimeLock(options))) {
        await rm(options.lockPath);
        continue;
      }
      throw new Error("Another Work daemon owns the lifetime lock.", { cause });
    }
  }
  throw new Error("Another Work daemon owns the lifetime lock.");
}

async function isStaleLifetimeLock(options: DaemonRuntimeOptions): Promise<boolean> {
  const metadata = await lstat(options.lockPath).catch(() => undefined);
  if (
    metadata === undefined ||
    !metadata.isFile() ||
    metadata.uid !== currentUserId() ||
    (metadata.mode & 0o077) !== 0
  ) {
    return false;
  }

  const owner = (await readFile(options.lockPath, "utf8").catch(() => "")).trim();
  if (/^[1-9]\d*$/.test(owner)) return !processExists(Number(owner));
  if (owner.length > 0 || Date.now() - metadata.mtimeMs < LEGACY_LOCK_STALE_AGE_MS) return false;

  return !(await listenerAccepts(options.socketPath, options.listenerProbeTimeoutMs ?? 250));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isNodeError(cause, "ESRCH");
  }
}

async function validateAndRemoveStaleSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const socket = await lstat(socketPath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (socket === undefined) return;
  if (!socket.isSocket()) throw new Error("The existing Work daemon path is not a Unix socket.");
  if (socket.uid !== currentUserId())
    throw new Error("The existing Work daemon socket has another owner.");
  if (await listenerAccepts(socketPath, timeoutMs)) {
    throw new Error("A Work daemon is already listening on the socket.");
  }
  await rm(socketPath);
}

function currentUserId(): number {
  if (process.getuid === undefined)
    throw new Error("The Work daemon requires Unix user identities.");
  return process.getuid();
}

function listenerAccepts(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveProbe(listening);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function isNodeError(cause: unknown, code: string): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function publicStartupMessage(cause: unknown): string {
  const message =
    cause instanceof Error ? cause.message : "The Work daemon runtime is unavailable.";
  return message.length <= 200 ? message : "The Work daemon runtime is unavailable.";
}
