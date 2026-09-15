#!/usr/bin/env bun
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { createWorkPaths } from "../shared/paths.ts";
import { ProcessPlatformLive } from "../infrastructure/process/index.ts";
import { makeEffectWorkDaemon } from "./effect-daemon.ts";
import { makeProductionWorkApplication } from "./production-application.ts";

/** Runs the production Effect daemon under one Scope. */
export async function runEffectWorkDaemon(): Promise<void> {
  const paths = createWorkPaths();
  const runtimeDirectory = process.env["XDG_RUNTIME_DIR"]!;
  const program = makeEffectWorkDaemon({
    runtimeDirectory,
    socketPath: paths.socket,
    lockPath: join(runtimeDirectory, "pi-workd.lock"),
    makeApplication: (lease) =>
      makeProductionWorkApplication(paths, lease).pipe(
        Effect.provide(ProcessPlatformLive),
        Effect.provide(BunFileSystem.layer),
      ),
    reportDefect: (correlationId, cause) =>
      Effect.sync(() => console.error(`pi-workd: internal error (${correlationId})`, cause)),
  });
  const fiber = Effect.runFork(Effect.scoped(program));
  const shutdown = (): void => {
    void Effect.runPromise(Fiber.interrupt(fiber));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const exit = await Effect.runPromise(Fiber.await(fiber));
  process.off("SIGTERM", shutdown);
  process.off("SIGINT", shutdown);
  if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
    throw Cause.squash(exit.cause);
  }
}

if (import.meta.main) {
  runEffectWorkDaemon().catch((error: unknown) => {
    console.error(`pi-workd: ${error instanceof Error ? error.message : "startup failed"}`);
    process.exitCode = 1;
  });
}
