import { afterEach, describe, expect, test } from "bun:test";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-bun/SqliteMigrator";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryPaths = new Set<string>();

async function makeTemporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-work-effect-contract-"));
  temporaryPaths.add(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { force: true, recursive: true });
      temporaryPaths.delete(path);
    }),
  );
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

interface BoundedOutput {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

function collectBounded(
  stream: Stream.Stream<Uint8Array, unknown>,
  limit: number,
): Effect.Effect<BoundedOutput, unknown> {
  return Stream.runFold(
    stream,
    (): BoundedOutput => ({ bytes: new Uint8Array(), totalBytes: 0, truncated: false }),
    (state, chunk): BoundedOutput => {
      const remaining = Math.max(0, limit - state.bytes.byteLength);
      const accepted = chunk.subarray(0, remaining);
      const bytes = new Uint8Array(state.bytes.byteLength + accepted.byteLength);
      bytes.set(state.bytes);
      bytes.set(accepted, state.bytes.byteLength);
      const totalBytes = state.totalBytes + chunk.byteLength;
      return { bytes, totalBytes, truncated: totalBytes > limit };
    },
  );
}

describe("Effect v4 foundation contracts", () => {
  test("ManagedRuntime constructs its Layer once and disposes scoped resources", async () => {
    let acquisitions = 0;
    let releases = 0;
    const resourceLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions += 1;
        }),
        () =>
          Effect.sync(() => {
            releases += 1;
          }),
      ),
    );
    const runtime = ManagedRuntime.make(resourceLayer);

    await runtime.runPromise(Effect.void);
    await runtime.runPromise(Effect.void);
    expect(acquisitions).toBe(1);
    expect(releases).toBe(0);

    await runtime.dispose();
    expect(releases).toBe(1);
  });

  test("TestClock advances sleeps without live time", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        let completed = false;
        const fiber = yield* Effect.forkChild(
          Effect.sleep("1 hour").pipe(
            Effect.andThen(
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        expect(completed).toBe(false);
        yield* TestClock.adjust("1 hour");
        yield* Fiber.join(fiber);
        return completed;
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(result).toBe(true);
  });

  test("Effect RPC round-trips through a scoped Unix socket with bounded NDJSON", async () => {
    const directory = await makeTemporaryDirectory();
    const socketPath = join(directory, "rpc.sock");
    const Echo = Rpc.make("Echo", {
      payload: { value: Schema.String },
      success: Schema.String,
    });
    const group = RpcGroup.make(Echo);
    const handlers = group.toLayer({
      Echo: ({ value }) => Effect.succeed(`echo:${value}`),
    });
    const serialization = RpcSerialization.layerNdjsonWith({ maxBufferSize: 1_024 });
    const server = RpcServer.layer(group).pipe(
      Layer.provide(handlers),
      Layer.provide(RpcServer.layerProtocolSocketServer),
      Layer.provide(serialization),
      Layer.provide(BunSocketServer.layer({ path: socketPath })),
    );
    const clientProtocol = RpcClient.layerProtocolSocket().pipe(
      Layer.provide(serialization),
      Layer.provide(BunSocket.layerNet({ path: socketPath })),
    );
    const live = Layer.merge(server, clientProtocol);

    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(live);
          const client = yield* RpcClient.make(group).pipe(Effect.provide(context));
          return yield* client.Echo({ value: "work" });
        }),
      ),
    );

    expect(response).toBe("echo:work");
    expect(await Bun.file(socketPath).exists()).toBe(false);
  });

  test("Bun SQLite migrates, commits, rolls back, enforces foreign keys, and closes", async () => {
    const directory = await makeTemporaryDirectory();
    const databasePath = join(directory, "work.db");
    const sqlLayer = SqliteClient.layer({ filename: databasePath });
    const migrations = SqliteMigrator.layer({
      loader: SqliteMigrator.fromRecord({
        "0001_contract": Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE parents (id INTEGER PRIMARY KEY)`;
          yield* sql`CREATE TABLE children (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES parents(id)
          )`;
        }),
      }),
    }).pipe(Layer.provideMerge(sqlLayer));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        yield* sql`INSERT INTO parents (id) VALUES (1)`;
        yield* sql.withTransaction(sql`INSERT INTO parents (id) VALUES (2)`);
        const rollbackExit = yield* Effect.exit(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO parents (id) VALUES (3)`;
              return yield* Effect.fail("rollback");
            }),
          ),
        );
        const foreignKeyExit = yield* Effect.exit(
          sql`INSERT INTO children (id, parent_id) VALUES (1, 999)`,
        );
        const rows = yield* sql<{ id: number }>`SELECT id FROM parents ORDER BY id`;
        const migrationRows = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM effect_sql_migrations
        `;
        return { foreignKeyExit, migrationRows, rollbackExit, rows };
      }).pipe(Effect.provide(migrations)),
    );

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.rollbackExit._tag).toBe("Failure");
    expect(result.foreignKeyExit._tag).toBe("Failure");
    expect(result.migrationRows).toEqual([{ count: 1 }]);

    await rm(databasePath);
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });

  test("interrupting a scoped Bun child terminates its descendant process group", async () => {
    const command = ChildProcess.make(
      "/bin/sh",
      ["-c", 'sleep 60 & descendant="$!"; printf "%s\\n" "$descendant"; wait'],
      { forceKillAfter: "1 second" },
    );
    let descendantPid: number | undefined;

    try {
      descendantPid = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const ready = yield* Deferred.make<number>();
            const fiber = yield* Effect.forkChild(
              Effect.scoped(
                Effect.gen(function* () {
                  const handle = yield* command;
                  const firstChunk = yield* Stream.runHead(handle.stdout);
                  if (Option.isNone(firstChunk)) {
                    return yield* Effect.die("child exited before its readiness signal");
                  }
                  const value = new TextDecoder().decode(firstChunk.value).trim();
                  yield* Deferred.succeed(ready, Number.parseInt(value, 10));
                  return yield* Effect.never;
                }),
              ),
            );
            const pid = yield* Deferred.await(ready);
            yield* Fiber.interrupt(fiber);
            return pid;
          }).pipe(Effect.provide(BunServices.layer)),
        ),
      );

      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      expect(processExists(descendantPid)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processExists(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  }, 10_000);

  test("combined Bun process output capture has a strict byte bound", async () => {
    const limit = 128;
    const command = ChildProcess.make("/bin/sh", [
      "-c",
      'i=0; while [ "$i" -lt 256 ]; do printf "out-%03d\\n" "$i"; printf "err-%03d\\n" "$i" >&2; i=$((i + 1)); done',
    ]);

    const output = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* command;
          const captured = yield* collectBounded(handle.all, limit);
          const exitCode = yield* handle.exitCode;
          expect(Number(exitCode)).toBe(0);
          return captured;
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    );

    expect(output.bytes.byteLength).toBe(limit);
    expect(output.totalBytes).toBeGreaterThan(limit);
    expect(output.truncated).toBe(true);
  });
});
