import { afterEach, describe, expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { chmod, lstat, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TopicCommands } from "../../application/command/index.ts";
import type { OperationEngine } from "../../application/operation/index.ts";
import { makeWorkState } from "../../application/state/index.ts";
import {
  RpcFailure,
  WORK_PROTOCOL_VERSION,
  WORK_STORAGE_SCHEMA_VERSION,
} from "../../domain/index.ts";
import { makeEffectWorkDaemon } from "../../daemon/effect-daemon.ts";
import {
  WorkRpcGroup,
  WorkStreamItem,
  WORK_RPC_MAX_FRAME_BYTES,
  type DaemonRuntimeLease,
  type WorkRpcApplication,
} from "./index.ts";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map(async (path) => {
      await rm(path, { force: true, recursive: true });
      temporaryDirectories.delete(path);
    }),
  );
});

async function temporaryRuntime(): Promise<{
  readonly directory: string;
  readonly socket: string;
  readonly lock: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-effect-rpc-"));
  temporaryDirectories.add(directory);
  await chmod(directory, 0o700);
  return {
    directory,
    socket: join(directory, "pi-workd.sock"),
    lock: join(directory, "pi-workd.lock"),
  };
}

function application(lease: DaemonRuntimeLease, defect = false): Effect.Effect<WorkRpcApplication> {
  return makeWorkState({
    daemon: { id: "daemon-test", startedAt: "2026-01-01T00:00:00.000Z" },
  }).pipe(
    Effect.map((state) => ({
      compatibility: Effect.succeed({
        applicationProtocol: WORK_PROTOCOL_VERSION,
        storageSchema: WORK_STORAGE_SCHEMA_VERSION,
        buildId: "test-build",
        startId: "daemon-test",
        state: "ready" as const,
      }),
      state,
      operations: {} as OperationEngine,
      commands: {} as TopicCommands,
      mainAgentCall: () =>
        defect ? Effect.die("injected request defect") : Effect.succeed({ status: "ok" }),
      ephemeralAction: () => Effect.void,
    })),
  );
}

describe("Effect RPC daemon", () => {
  test("serves compatibility and snapshot-first state on a mode 0600 Unix socket", async () => {
    const paths = await temporaryRuntime();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: application,
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);

          const socketMetadata = yield* Effect.promise(() => lstat(paths.socket));
          const lockMetadata = yield* Effect.promise(() => lstat(paths.lock));
          expect(socketMetadata.mode & 0o777).toBe(0o600);
          expect(lockMetadata.mode & 0o777).toBe(0o600);

          const serialization = RpcSerialization.layerNdjsonWith({
            maxBufferSize: WORK_RPC_MAX_FRAME_BYTES,
          });
          const protocol = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(serialization),
            Layer.provide(BunSocket.layerNet({ path: paths.socket })),
          );
          const context = yield* Layer.build(protocol);
          const client = yield* RpcClient.make(WorkRpcGroup).pipe(Effect.provide(context));
          expect(yield* client.Compatibility()).toEqual({
            applicationProtocol: WORK_PROTOCOL_VERSION,
            storageSchema: WORK_STORAGE_SCHEMA_VERSION,
            buildId: "test-build",
            startId: "daemon-test",
            state: "ready",
          });
          expect(yield* client.EphemeralAction({ action: "refresh" })).toEqual({
            status: "completed",
          });
          const first = yield* client.SubscribeState({ capacity: 1 }).pipe(Stream.runHead);
          expect(first._tag).toBe("Some");
          if (first._tag === "Some") expect(first.value._tag).toBe("Snapshot");

          yield* Fiber.interrupt(daemon);
        }),
      ),
    );

    expect(await Bun.file(paths.socket).exists()).toBe(false);
    expect(await Bun.file(paths.lock).exists()).toBe(false);
  });

  test("stops while a state subscription remains connected", async () => {
    const paths = await temporaryRuntime();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: application,
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);

          const serialization = RpcSerialization.layerNdjsonWith({
            maxBufferSize: WORK_RPC_MAX_FRAME_BYTES,
          });
          const protocol = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(serialization),
            Layer.provide(BunSocket.layerNet({ path: paths.socket })),
          );
          const context = yield* Layer.build(protocol);
          const client = yield* RpcClient.make(WorkRpcGroup).pipe(Effect.provide(context));
          const subscribed = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            client.SubscribeState({ capacity: 16 }).pipe(
              Stream.tap(() => Deferred.succeed(subscribed, undefined)),
              Stream.runDrain,
            ),
          );
          yield* Deferred.await(subscribed);

          const result = yield* Effect.raceFirst(
            Fiber.interrupt(daemon).pipe(Effect.as("stopped" as const)),
            Effect.sleep("500 millis").pipe(Effect.as("timeout" as const)),
          );
          expect(result).toBe("stopped");
        }),
      ),
    );
  });

  test("recovers an old empty lifetime lock left by an unclean daemon exit", async () => {
    const paths = await temporaryRuntime();
    await writeFile(paths.lock, "", { mode: 0o600 });
    const staleTime = new Date(Date.now() - 10_000);
    await utimes(paths.lock, staleTime, staleTime);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: application,
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(daemon);
        }),
      ),
    );

    expect(await Bun.file(paths.socket).exists()).toBe(false);
    expect(await Bun.file(paths.lock).exists()).toBe(false);
  });

  test("refuses a second daemon before it constructs application storage", async () => {
    const paths = await temporaryRuntime();
    let secondConstructed = false;

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const first = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: application,
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);
          const second = yield* Effect.exit(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: (lease) => {
                secondConstructed = true;
                return application(lease);
              },
            }),
          );
          expect(second._tag).toBe("Failure");
          expect(secondConstructed).toBe(false);
          yield* Fiber.interrupt(first);
        }),
      ),
    );
  });

  test("maps one request defect to a bounded error without stopping later requests", async () => {
    const paths = await temporaryRuntime();

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: (lease) => application(lease, true),
              ready: Deferred.succeed(ready, undefined),
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);
          const serialization = RpcSerialization.layerNdjsonWith({
            maxBufferSize: WORK_RPC_MAX_FRAME_BYTES,
          });
          const protocol = RpcClient.layerProtocolSocket().pipe(
            Layer.provide(serialization),
            Layer.provide(BunSocket.layerNet({ path: paths.socket })),
          );
          const context = yield* Layer.build(protocol);
          const client = yield* RpcClient.make(WorkRpcGroup).pipe(Effect.provide(context));
          const failed = yield* Effect.flip(
            client.MainAgentCall({ action: "heartbeat", connectionId: "connection" }),
          );
          expect(failed).toBeInstanceOf(RpcFailure);
          expect(failed.reason).toBe("internal");
          expect((yield* client.Compatibility()).state).toBe("ready");
          yield* Fiber.interrupt(daemon);
        }),
      ),
    );
  });

  test("runs the bounded shutdown stages in the required order", async () => {
    const paths = await temporaryRuntime();
    const stages: string[] = [];
    const stage = (name: string) => Effect.sync(() => stages.push(name)).pipe(Effect.asVoid);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ready = yield* Deferred.make<void>();
          const daemon = yield* Effect.forkScoped(
            makeEffectWorkDaemon({
              runtimeDirectory: paths.directory,
              socketPath: paths.socket,
              lockPath: paths.lock,
              makeApplication: application,
              ready: Deferred.succeed(ready, undefined),
              stopping: stage("stopping"),
              shutdown: {
                stopAccepting: stage("stop-accepting"),
                stopSchedules: stage("stop-schedules"),
                drainAtomicCommands: stage("drain-atomic"),
                closeClientWaits: stage("close-waits"),
                interruptEphemeralActions: stage("interrupt-ephemeral"),
                checkpointDurableOperations: stage("checkpoint-durable"),
                terminateProcesses: stage("terminate-processes"),
              },
              shutdownDeadlineMs: 100,
            }),
          );
          yield* Deferred.await(ready);
          yield* Fiber.interrupt(daemon);
        }),
      ),
    );

    expect(stages).toEqual([
      "stop-accepting",
      "stopping",
      "stop-schedules",
      "drain-atomic",
      "close-waits",
      "interrupt-ephemeral",
      "checkpoint-durable",
      "terminate-processes",
    ]);
  });

  test("rejects stream items larger than the explicit frame bound", () => {
    const decode = Schema.decodeUnknownSync(WorkStreamItem);
    expect(() =>
      decode({
        _tag: "ResyncRequired",
        daemonId: "x".repeat(WORK_RPC_MAX_FRAME_BYTES),
        expectedRevision: 1,
        actualRevision: 2,
      }),
    ).toThrow();
  });
});
