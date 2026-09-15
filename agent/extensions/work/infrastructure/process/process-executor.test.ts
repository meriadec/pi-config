import { afterEach, describe, expect, test } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessFailure } from "../../domain/index.ts";
import {
  makeProcessExecutor,
  ProcessPlatformLive,
  runProcessPromise,
  type ProcessRequest,
} from "./process-executor.ts";

const roots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-work-process-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executable(
  command: string,
  arguments_: readonly string[],
  overrides: Partial<Omit<ProcessRequest, "command">> = {},
): ProcessRequest {
  return {
    command: { _tag: "Executable", executable: command, arguments: arguments_ },
    cwd: process.cwd(),
    timeoutMs: 2_000,
    maxOutputBytes: 8 * 1024,
    ...overrides,
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readPid(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    } catch {
      await Bun.sleep(10);
    }
  }
  throw new Error("The child did not publish its descendant PID.");
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processExists(pid); attempt += 1) {
    await Bun.sleep(10);
  }
  expect(processExists(pid)).toBe(false);
}

describe("scoped process executor", () => {
  test("maps spawn failures to a safe typed failure with a hidden cause", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        makeProcessExecutor().run(executable("/path/that/does/not/exist", [], { timeoutMs: 100 })),
      ).pipe(Effect.provide(ProcessPlatformLive)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) throw new Error("The missing executable started.");
    const failure = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(failure)).toBe(true);
    if (Option.isNone(failure)) throw new Error("The failure had no typed value.");
    expect(failure.value).toBeInstanceOf(ProcessFailure);
    expect(failure.value).toMatchObject({
      reason: "spawn",
      message: "The process could not start.",
    });
    expect(Object.keys(failure.value)).not.toContain("internalCause");
  });

  test("uses one strict byte bound across stdout and stderr while draining all output", async () => {
    const result = await runProcessPromise(
      executable(
        "/bin/sh",
        [
          "-c",
          'i=0; while [ "$i" -lt 2000 ]; do printf "stdout-data"; printf "stderr-data" >&2; i=$((i + 1)); done',
        ],
        { maxOutputBytes: 127 },
      ),
    );

    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      127,
    );
    expect(result.outputTruncated).toBe(true);
  });

  test("applies environment additions before exact removals", async () => {
    const result = await runProcessPromise(
      executable(
        process.execPath,
        ["-e", "console.log(JSON.stringify([process.env.KEEP, process.env.REMOVE]))"],
        {
          environment: { KEEP: "yes", REMOVE: "no" },
          unsetEnvironment: ["REMOVE"],
        },
      ),
    );

    expect(JSON.parse(result.stdout)).toEqual(["yes", null]);
  });

  test("runs shell text only through the Repository Recipe command form", async () => {
    const result = await runProcessPromise({
      command: { _tag: "RepositoryRecipe", shell: "/bin/bash", command: "printf recipe" },
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 100,
    });

    expect(result).toMatchObject({ status: "completed", exitCode: 0, stdout: "recipe" });
  });

  test("times out, escalates when SIGTERM is ignored, and awaits group exit", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "descendant.pid");
    const result = await runProcessPromise(
      executable(
        "/bin/sh",
        [
          "-c",
          'trap "" TERM; trap "" TERM; sleep 60 & descendant=$!; printf "%s" "$descendant" > "$1"; wait',
          "process-test",
          pidPath,
        ],
        { timeoutMs: 50, terminationGraceMs: 50 },
      ),
    );
    const descendantPid = await readPid(pidPath);

    expect(result.status).toBe("timeout");
    expect(result.exitCode).toBeNull();
    await expectProcessGone(descendantPid);
  });

  test("cancellation interrupts the Scope and leaves no descendant", async () => {
    const root = await temporaryDirectory();
    const pidPath = join(root, "descendant.pid");
    const controller = new AbortController();
    const running = runProcessPromise(
      executable(
        "/bin/sh",
        ["-c", 'sleep 60 & descendant=$!; printf "%s" "$descendant" > "$1"; wait', "test", pidPath],
        { timeoutMs: 60_000, terminationGraceMs: 50 },
      ),
      controller.signal,
    );
    const descendantPid = await readPid(pidPath);

    controller.abort();
    expect((await running).status).toBe("cancelled");
    await expectProcessGone(descendantPid);
  });
});
