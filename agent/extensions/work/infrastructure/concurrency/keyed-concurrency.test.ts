import { describe, expect, test } from "bun:test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  creationKey,
  familyKey,
  makeKeyedConcurrency,
  repositoryKey,
  topicKey,
} from "./keyed-concurrency.ts";
import { makeProcessPermit } from "./process-permit.ts";

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);

function gated(
  entered: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
): Effect.Effect<void> {
  return Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
}

describe("keyed structured concurrency", () => {
  test("serializes the same key and removes its entry", async () => {
    await run(
      Effect.gen(function* () {
        const concurrency = makeKeyedConcurrency();
        const firstEntered = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const key = topicKey("topic-1");
        const first = yield* Effect.forkChild(
          concurrency.withKeys([key], gated(firstEntered, firstRelease)),
        );
        yield* Deferred.await(firstEntered);
        const second = yield* Effect.forkChild(
          concurrency.withKeys([key, key], gated(secondEntered, secondRelease)),
        );
        expect(yield* Deferred.isDone(secondEntered)).toBe(false);
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondEntered);
        yield* Deferred.succeed(secondRelease, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* concurrency.retainedKeyCount).toBe(0);
      }),
    );
  });

  test("runs independent keys concurrently", async () => {
    await run(
      Effect.gen(function* () {
        const concurrency = makeKeyedConcurrency();
        const firstEntered = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          concurrency.withKeys([topicKey("one")], gated(firstEntered, release)),
        );
        const second = yield* Effect.forkChild(
          concurrency.withKeys([repositoryKey("owner/repo")], gated(secondEntered, release)),
        );
        yield* Deferred.await(firstEntered);
        yield* Deferred.await(secondEntered);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  test("sorts multi-key acquisition and prevents opposite-order deadlock", async () => {
    await run(
      Effect.gen(function* () {
        const concurrency = makeKeyedConcurrency();
        const firstEntered = yield* Deferred.make<void>();
        const firstRelease = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const secondRelease = yield* Deferred.make<void>();
        const topic = topicKey("one");
        const family = familyKey("family");
        const first = yield* Effect.forkChild(
          concurrency.withKeys([topic, family], gated(firstEntered, firstRelease)),
        );
        yield* Deferred.await(firstEntered);
        const second = yield* Effect.forkChild(
          concurrency.withKeys([family, topic], gated(secondEntered, secondRelease)),
        );
        expect(yield* Deferred.isDone(secondEntered)).toBe(false);
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Deferred.await(secondEntered);
        yield* Deferred.succeed(secondRelease, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  test("waiting and holding fibers release references when interrupted", async () => {
    await run(
      Effect.gen(function* () {
        const concurrency = makeKeyedConcurrency();
        const holderEntered = yield* Deferred.make<void>();
        const neverRelease = yield* Deferred.make<void>();
        const waiterEntered = yield* Deferred.make<void>();
        const key = creationKey("owner/repo", "main");
        const holder = yield* Effect.forkChild(
          concurrency.withKeys([key], gated(holderEntered, neverRelease)),
        );
        yield* Deferred.await(holderEntered);
        const waiter = yield* Effect.forkChild(
          concurrency.withKeys([key], Deferred.succeed(waiterEntered, undefined)),
        );
        yield* Fiber.interrupt(waiter);
        expect(yield* Deferred.isDone(waiterEntered)).toBe(false);
        expect(yield* concurrency.retainedKeyCount).toBe(1);
        yield* Fiber.interrupt(holder);
        expect(yield* concurrency.retainedKeyCount).toBe(0);

        yield* concurrency.withKeys([key], Effect.void);
        expect(yield* concurrency.retainedKeyCount).toBe(0);
      }),
    );
  });

  test("releases keys after failure, defect, and timeout", async () => {
    await run(
      Effect.gen(function* () {
        const concurrency = makeKeyedConcurrency();
        const key = repositoryKey("owner/repo");
        yield* Effect.exit(concurrency.withKeys([key], Effect.fail("expected")));
        expect(yield* concurrency.retainedKeyCount).toBe(0);
        yield* Effect.exit(concurrency.withKeys([key], Effect.die("defect")));
        expect(yield* concurrency.retainedKeyCount).toBe(0);
        yield* concurrency.withKeys([key], Effect.never).pipe(Effect.timeoutOption(0));
        expect(yield* concurrency.retainedKeyCount).toBe(0);
      }),
    );
  });

  test("bounds expensive process work", async () => {
    await run(
      Effect.gen(function* () {
        const permit = makeProcessPermit(2);
        const release = yield* Deferred.make<void>();
        const firstTwoEntered = yield* Deferred.make<void>();
        let active = 0;
        let maximum = 0;
        let entries = 0;
        const work = Effect.acquireUseRelease(
          Effect.sync(() => {
            active += 1;
            entries += 1;
            maximum = Math.max(maximum, active);
            return entries;
          }).pipe(
            Effect.flatMap((count) =>
              count === 2 ? Deferred.succeed(firstTwoEntered, undefined) : Effect.void,
            ),
          ),
          () => Deferred.await(release),
          () =>
            Effect.sync(() => {
              active -= 1;
            }),
        );
        const fibers = [
          yield* Effect.forkChild(permit.withPermit(work)),
          yield* Effect.forkChild(permit.withPermit(work)),
          yield* Effect.forkChild(permit.withPermit(work)),
          yield* Effect.forkChild(permit.withPermit(work)),
        ];
        yield* Deferred.await(firstTwoEntered);
        expect(entries).toBe(2);
        expect(maximum).toBe(2);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join, { concurrency: "unbounded" });
        expect(maximum).toBe(2);
      }),
    );
  });
});
