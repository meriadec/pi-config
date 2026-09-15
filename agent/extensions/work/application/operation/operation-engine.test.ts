import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { ClientId, OperationId, PrivateLocalCapability, RequestId } from "../../domain/index.ts";
import {
  OperationRepository,
  operationRepositoryLayer,
} from "../../infrastructure/storage/index.ts";
import { makeWorkState } from "../state/index.ts";
import {
  makeOperationEngine,
  type OperationEngine,
  type OperationWorker,
} from "./operation-engine.ts";

const CLIENT = Schema.decodeUnknownSync(ClientId)("11111111-1111-4111-8111-111111111111");
const REQUEST = Schema.decodeUnknownSync(RequestId)("22222222-2222-4222-8222-222222222222");
const SECOND_REQUEST = Schema.decodeUnknownSync(RequestId)("33333333-3333-4333-8333-333333333333");
const OPERATION = Schema.decodeUnknownSync(OperationId)("44444444-4444-4444-8444-444444444444");
const SECOND_OPERATION = Schema.decodeUnknownSync(OperationId)(
  "55555555-5555-4555-8555-555555555555",
);
const CAPABILITY = Schema.decodeUnknownSync(PrivateLocalCapability)("safe-engine-confirmation");
const input = { version: 1 as const, kind: "test", value: { name: "operation" } };
const success = { version: 1 as const, status: "succeeded" as const, value: { done: true } };
const paths = new Set<string>();

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-operation-engine-"));
  paths.add(directory);
  return join(directory, "work.db");
}

afterEach(async () => {
  await Promise.all([...paths].map((path) => rm(path, { recursive: true, force: true })));
  paths.clear();
});

function withEngine<A, E>(
  path: string,
  worker: OperationWorker,
  use: (engine: OperationEngine, repository: OperationRepository) => Effect.Effect<A, E>,
  operationId = OPERATION,
  options?: { readonly retentionIntervalMs?: number; readonly onPrune?: () => void },
) {
  return Effect.gen(function* () {
    const repository = yield* OperationRepository;
    const state = yield* makeWorkState({
      daemon: { id: "test-daemon", startedAt: "2026-01-01T00:00:00.000Z" },
    });
    const engineRepository =
      options?.onPrune === undefined
        ? repository
        : {
            ...repository,
            pruneTerminalResults: (now: string, maximum?: number) =>
              Effect.sync(options.onPrune!).pipe(
                Effect.andThen(repository.pruneTerminalResults(now, maximum)),
              ),
          };
    const engine = yield* makeOperationEngine({
      repository: engineRepository,
      state,
      workers: { test: worker },
      makeOperationId: () => operationId,
      makeCapability: () => CAPABILITY,
      ...(options?.retentionIntervalMs === undefined
        ? {}
        : { retentionIntervalMs: options.retentionIntervalMs }),
    });
    return yield* use(engine, repository);
  }).pipe(Effect.scoped, Effect.provide(operationRepositoryLayer({ filename: path })));
}

const startRequest = (requestId = REQUEST) => ({
  clientId: CLIENT,
  requestId,
  fingerprint: `test:${requestId}`,
  input,
});

describe("Durable Operation engine", () => {
  test("keeps the worker alive when one client stops awaiting", async () => {
    const path = await databasePath();
    await Effect.runPromise(
      withEngine(
        path,
        {
          resumable: true,
          run: () =>
            Effect.gen(function* () {
              const release = yield* Deferred.make<void>();
              yield* Deferred.succeed(workerRelease, release);
              yield* Deferred.await(release);
              return success;
            }),
        },
        (engine) =>
          Effect.gen(function* () {
            yield* engine.start(startRequest());
            const release = yield* Deferred.await(workerRelease);
            const waiting = yield* Effect.forkChild(engine.await(OPERATION));
            yield* Fiber.interrupt(waiting);
            expect(yield* engine.activeWorkerCount).toBe(1);
            yield* Deferred.succeed(release, undefined);
            expect((yield* engine.await(OPERATION)).state).toBe("succeeded");
          }),
      ),
    );
  });

  test("replays one accepted command identity without repeating its side effect", async () => {
    const path = await databasePath();
    let sideEffects = 0;
    await Effect.runPromise(
      withEngine(
        path,
        {
          resumable: false,
          run: () =>
            Effect.sync(() => {
              sideEffects += 1;
              return success;
            }),
        },
        (engine) =>
          Effect.gen(function* () {
            const first = yield* engine.start(startRequest());
            const retry = yield* engine.start(startRequest());
            expect(retry.id).toBe(first.id);
            yield* engine.await(first.id);
          }),
      ),
    );
    expect(sideEffects).toBe(1);
  });

  test("recovers resumable accepted work after a daemon scope restart", async () => {
    const path = await databasePath();
    await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.never }, (engine) =>
        engine.start(startRequest()),
      ),
    );

    const recovered = await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.succeed(success) }, (engine) =>
        Effect.andThen(engine.recover, engine.await(OPERATION)),
      ),
    );
    expect(recovered.state).toBe("succeeded");
  });

  test("marks a running Setup command as interrupted instead of resuming it", async () => {
    const path = await databasePath();
    const recovered = await Effect.runPromise(
      withEngine(
        path,
        { resumable: true, run: () => Effect.succeed(success) },
        (engine, repository) =>
          Effect.gen(function* () {
            yield* repository.claim({
              id: OPERATION,
              clientId: CLIENT,
              requestId: REQUEST,
              fingerprint: "setup-interruption",
              operationInput: input,
              phase: "accepted",
              now: "2026-01-01T00:00:00.000Z",
            });
            yield* repository.transition({
              id: OPERATION,
              expectedState: "accepted",
              expectedRevision: 0,
              state: "running",
              phase: "setup",
              now: "2026-01-01T00:00:01.000Z",
            });
            yield* repository.startSetupStep(OPERATION, 0, 1, "2026-01-01T00:00:02.000Z");
            yield* engine.recover;
            return yield* engine.get(OPERATION);
          }),
      ),
    );
    expect(recovered.state).toBe("setup-interrupted");
    expect(recovered.phase).toBe("setup-interrupted");
  });

  test("keeps durable confirmation one-use across restart", async () => {
    const path = await databasePath();
    const handle = await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.succeed(success) }, (engine) =>
        engine.start({
          ...startRequest(),
          confirmation: { action: "start", lifetimeMs: 60_000, durable: true },
        }),
      ),
    );
    expect(handle.state).toBe("awaiting-confirmation");
    expect(Redacted.value(handle.confirmation!)).toBe(Redacted.value(CAPABILITY));

    const completed = await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.succeed(success) }, (engine) =>
        Effect.gen(function* () {
          yield* engine.recover;
          yield* engine.confirm(OPERATION, CAPABILITY);
          return yield* engine.await(OPERATION);
        }),
      ),
    );
    expect(completed.state).toBe("succeeded");
  });

  test("expires confirmation with Effect time", async () => {
    const path = await databasePath();
    const state = await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.succeed(success) }, (engine) =>
        Effect.gen(function* () {
          yield* engine.start({
            ...startRequest(),
            confirmation: { action: "start", lifetimeMs: 1_000, durable: false },
          });
          yield* TestClock.adjust("1 second");
          yield* Effect.yieldNow;
          return (yield* engine.get(OPERATION)).state;
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(state).toBe("failed");
  });

  test("cancels only after a one-use direct confirmation", async () => {
    const path = await databasePath();
    const cancelled = await Effect.runPromise(
      withEngine(path, { resumable: true, run: () => Effect.never }, (engine) =>
        Effect.gen(function* () {
          yield* engine.start(startRequest());
          const capability = yield* engine.requestCancellation(OPERATION, 60_000);
          return yield* engine.confirm(OPERATION, capability);
        }),
      ),
    );
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.result?.status).toBe("cancelled");
  });

  test("runs retention on Effect time", async () => {
    const path = await databasePath();
    let prunes = 0;
    await Effect.runPromise(
      withEngine(
        path,
        { resumable: true, run: () => Effect.succeed(success) },
        () =>
          Effect.gen(function* () {
            yield* TestClock.adjust("1 second");
            yield* Effect.yieldNow;
          }),
        OPERATION,
        { retentionIntervalMs: 1_000, onPrune: () => (prunes += 1) },
      ).pipe(Effect.provide(TestClock.layer())),
    );
    expect(prunes).toBe(1);
  });

  test("replays an Atomic Command result without a second side effect", async () => {
    const path = await databasePath();
    let effects = 0;
    await Effect.runPromise(
      withEngine(
        path,
        { resumable: true, run: () => Effect.succeed(success) },
        (engine) =>
          Effect.gen(function* () {
            const command = Effect.sync(() => {
              effects += 1;
              return success;
            });
            yield* engine.executeAtomicCommand(
              { clientId: CLIENT, requestId: SECOND_REQUEST, fingerprint: "atomic" },
              command,
            );
            yield* engine.executeAtomicCommand(
              { clientId: CLIENT, requestId: SECOND_REQUEST, fingerprint: "atomic" },
              command,
            );
          }),
        SECOND_OPERATION,
      ),
    );
    expect(effects).toBe(1);
  });
});

const workerRelease = Deferred.makeUnsafe<Deferred.Deferred<void>>();
