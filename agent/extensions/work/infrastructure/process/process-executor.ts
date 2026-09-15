import * as BunChildProcessSpawner from "@effect/platform-bun/BunChildProcessSpawner";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";
import { ProcessFailure } from "../../domain/index.ts";
import { globalProcessPermit, type ProcessPermit } from "../concurrency/index.ts";

export const GIT_LOCAL_ENVIRONMENT_VARIABLES = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_WORK_TREE",
] as const;

export type ProcessStatus = "completed" | "timeout" | "cancelled";

export type ProcessCommand =
  | {
      readonly _tag: "Executable";
      readonly executable: string;
      readonly arguments?: readonly string[];
    }
  | {
      /** Shell input is only for a configured Repository Recipe command. */
      readonly _tag: "RepositoryRecipe";
      readonly shell: string;
      readonly command: string;
    };

export interface ProcessRequest {
  readonly command: ProcessCommand;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly unsetEnvironment?: readonly string[];
  readonly terminationGraceMs?: number;
}

export interface ProcessResult {
  readonly status: ProcessStatus;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
}

export interface ProcessExecutor {
  readonly run: (
    request: ProcessRequest,
  ) => Effect.Effect<ProcessResult, ProcessFailure, ChildProcessSpawner | Scope.Scope>;
}

export const ProcessExecutor = Context.Service<ProcessExecutor>("Work/ProcessExecutor");

interface CaptureState {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  capturedBytes: number;
  truncated: boolean;
}

const decoder = new TextDecoder();

export const makeProcessExecutor = (
  permit: ProcessPermit = globalProcessPermit,
): ProcessExecutor => ({
  run: (request) =>
    permit.withPermit(
      Effect.gen(function* () {
        const capture: CaptureState = {
          stdout: [],
          stderr: [],
          capturedBytes: 0,
          truncated: false,
        };
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) {
          if (value !== undefined) environment[name] = value;
        }
        Object.assign(environment, request.environment);
        for (const name of request.unsetEnvironment ?? []) delete environment[name];

        const specification = request.command;
        const executable =
          specification._tag === "Executable" ? specification.executable : specification.shell;
        const args =
          specification._tag === "Executable"
            ? [...(specification.arguments ?? [])]
            : ["-lc", specification.command];
        const command = ChildProcess.make(executable, args, {
          cwd: request.cwd,
          env: environment,
          extendEnv: false,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          detached: true,
          killSignal: "SIGTERM",
          forceKillAfter: request.terminationGraceMs ?? 250,
        });

        const handle = yield* command.pipe(
          Effect.mapError(
            (cause) =>
              new ProcessFailure({
                reason: "spawn",
                message: "The process could not start.",
                internalCause: cause,
              }),
          ),
        );
        const collect = (target: "stdout" | "stderr", stream: Stream.Stream<Uint8Array, unknown>) =>
          Stream.runForEach(stream, (chunk) =>
            Effect.sync(() => {
              const remaining = Math.max(0, request.maxOutputBytes - capture.capturedBytes);
              const accepted = chunk.subarray(0, remaining);
              if (accepted.byteLength > 0) capture[target].push(accepted.slice());
              capture.capturedBytes += accepted.byteLength;
              if (accepted.byteLength < chunk.byteLength) capture.truncated = true;
            }),
          );
        const stdoutFiber = yield* Effect.forkScoped(collect("stdout", handle.stdout));
        const stderrFiber = yield* Effect.forkScoped(collect("stderr", handle.stderr));

        const exit = yield* handle.exitCode.pipe(
          Effect.timeoutOption(request.timeoutMs),
          Effect.mapError(
            (cause) =>
              new ProcessFailure({
                reason: "exit",
                message: "The process did not report its exit status.",
                internalCause: cause,
              }),
          ),
        );
        let status: ProcessStatus = "completed";
        let exitCode: number | null = null;
        if (Option.isSome(exit)) {
          exitCode = Number(exit.value);
          // A successful leader can leave background descendants and open output pipes.
          // Signal and await the complete owned group before this Scope can release.
          yield* Effect.ignore(
            handle.kill({
              killSignal: "SIGTERM",
              forceKillAfter: request.terminationGraceMs ?? 250,
            }),
          );
        } else {
          status = "timeout";
          yield* handle
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: request.terminationGraceMs ?? 250,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ProcessFailure({
                    reason: "timeout",
                    message: "The process timed out and could not be stopped cleanly.",
                    internalCause: cause,
                  }),
              ),
            );
        }
        yield* Fiber.join(stdoutFiber).pipe(
          Effect.andThen(Fiber.join(stderrFiber)),
          Effect.mapError(
            (cause) =>
              new ProcessFailure({
                reason: "exit",
                message: "The process output could not be read.",
                internalCause: cause,
              }),
          ),
        );
        return {
          status,
          exitCode,
          stdout: decode(capture.stdout),
          stderr: decode(capture.stderr),
          outputTruncated: capture.truncated,
        };
      }),
    ),
});

export const ProcessExecutorLive = Layer.succeed(ProcessExecutor, makeProcessExecutor());
export const ProcessPlatformLive = BunChildProcessSpawner.layer.pipe(
  Layer.provide([BunFileSystem.layer, BunPath.layer]),
);

/** Run one process in a fresh Scope. Use only at old Promise-based call sites. */
export function runProcessPromise(
  request: ProcessRequest,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted === true) return Promise.resolve(emptyProcessResult("cancelled"));
  return Effect.runPromise(
    Effect.scoped(makeProcessExecutor().run(request)).pipe(Effect.provide(ProcessPlatformLive)),
    { signal },
  ).catch((error: unknown) => {
    if (signal?.aborted === true) return emptyProcessResult("cancelled");
    throw error;
  });
}

export function emptyProcessResult(status: ProcessStatus): ProcessResult {
  return { status, exitCode: null, stdout: "", stderr: "", outputTruncated: false };
}

function decode(chunks: readonly Uint8Array[]): string {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}
