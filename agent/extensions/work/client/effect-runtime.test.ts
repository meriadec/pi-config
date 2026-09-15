import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { TopicCommands } from "../application/command/index.ts";
import type { OperationEngine } from "../application/operation/index.ts";
import { makeWorkState } from "../application/state/index.ts";
import { makeEffectWorkDaemon } from "../daemon/effect-daemon.ts";
import { WORK_PROTOCOL_VERSION, WORK_STORAGE_SCHEMA_VERSION } from "../domain/index.ts";
import type { DaemonRuntimeLease, WorkRpcApplication } from "../infrastructure/rpc/index.ts";
import { makeWorkClientRuntime } from "./effect-runtime.ts";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (path) => {
      await rm(path, { recursive: true, force: true });
      temporaryDirectories.delete(path);
    }),
  );
});

describe("managed Effect RPC client runtime", () => {
  test("connects to a real daemon and disposes its socket runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-work-client-runtime-"));
    temporaryDirectories.add(directory);
    await chmod(directory, 0o700);
    const socketPath = join(directory, "pi-workd.sock");
    const lockPath = join(directory, "pi-workd.lock");

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: directory,
              socketPath,
              lockPath,
              makeApplication: (_lease: DaemonRuntimeLease) =>
                makeWorkState({
                  daemon: { id: "daemon-client-test", startedAt: "2026-01-01T00:00:00.000Z" },
                }).pipe(
                  Effect.map((projection): WorkRpcApplication => {
                    return {
                      compatibility: Effect.succeed({
                        applicationProtocol: WORK_PROTOCOL_VERSION,
                        storageSchema: WORK_STORAGE_SCHEMA_VERSION,
                        buildId: "client-test-build",
                        startId: "daemon-client-test",
                        state: "ready",
                      }),
                      state: projection,
                      operations: {} as OperationEngine,
                      commands: {} as TopicCommands,
                      mainAgentCall: () => Effect.succeed({}),
                      ephemeralAction: () => Effect.void,
                    };
                  }),
                ),
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);

          const runtime = makeWorkClientRuntime({ socketPath, reconnectDelayMs: 5 });
          expect((yield* Effect.promise(() => runtime.compatibility())).startId).toBe(
            "daemon-client-test",
          );
          yield* Effect.promise(() => runtime.dispose());
          yield* Fiber.interrupt(daemon);
        }),
      ),
    );
  });
});
