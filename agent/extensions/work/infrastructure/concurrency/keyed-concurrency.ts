import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export type ConcurrencyKey =
  | { readonly _tag: "Topic"; readonly topicId: string }
  | { readonly _tag: "Family"; readonly familyId: string }
  | { readonly _tag: "Repository"; readonly repository: string }
  | { readonly _tag: "Creation"; readonly repository: string; readonly branch: string };

export const topicKey = (topicId: string): ConcurrencyKey => ({ _tag: "Topic", topicId });
export const familyKey = (familyId: string): ConcurrencyKey => ({ _tag: "Family", familyId });
export const repositoryKey = (repository: string): ConcurrencyKey => ({
  _tag: "Repository",
  repository,
});
export const creationKey = (repository: string, branch: string): ConcurrencyKey => ({
  _tag: "Creation",
  repository,
  branch,
});

export interface KeyedConcurrency {
  readonly withKeys: <A, E, R>(
    keys: Iterable<ConcurrencyKey>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** A diagnostic for retention checks. Application policy must not depend on it. */
  readonly retainedKeyCount: Effect.Effect<number>;
}

interface Entry {
  readonly semaphore: Semaphore.Semaphore;
  references: number;
}

/** Make an isolated keyed coordinator. Its mutable table is private to this deep module. */
export function makeKeyedConcurrency(): KeyedConcurrency {
  const entries = new Map<string, Entry>();

  const acquire = (encoded: string) =>
    Effect.gen(function* () {
      const entry = yield* Effect.sync(() => {
        const current = entries.get(encoded);
        if (current !== undefined) {
          current.references += 1;
          return current;
        }
        const created: Entry = { semaphore: Semaphore.makeUnsafe(1), references: 1 };
        entries.set(encoded, created);
        return created;
      });
      yield* entry.semaphore
        .take(1)
        .pipe(Effect.onInterrupt(() => releaseReference(entries, encoded, entry)));
      return entry;
    });

  const withOne = <A, E, R>(
    encoded: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          acquire(encoded),
          (held) =>
            held.semaphore
              .release(1)
              .pipe(Effect.andThen(releaseReference(entries, encoded, held))),
          { interruptible: true },
        );
        return yield* effect;
      }),
    );

  return {
    withKeys: (keys, effect) => {
      const ordered = [...new Set(Array.from(keys, encodeKey))].sort();
      return ordered.reduceRight((protectedEffect, key) => withOne(key, protectedEffect), effect);
    },
    retainedKeyCount: Effect.sync(() => entries.size),
  };
}

/** Promise bridge for old call sites. New Effect modules use `withKeys` directly. */
export function withKeysPromise<A>(
  concurrency: KeyedConcurrency,
  keys: Iterable<ConcurrencyKey>,
  operation: () => Promise<A>,
  signal?: AbortSignal,
): Promise<A> {
  return Effect.runPromise(
    concurrency.withKeys(
      keys,
      Effect.tryPromise({
        try: operation,
        catch: (cause) => cause,
      }),
    ),
    signal === undefined || signal.aborted ? undefined : { signal },
  );
}

function releaseReference(
  entries: Map<string, Entry>,
  encoded: string,
  entry: Entry,
): Effect.Effect<void> {
  return Effect.sync(() => {
    entry.references -= 1;
    if (entry.references === 0 && entries.get(encoded) === entry) entries.delete(encoded);
  });
}

function encodeKey(key: ConcurrencyKey): string {
  switch (key._tag) {
    case "Topic":
      return `0:${JSON.stringify(key.topicId)}`;
    case "Family":
      return `1:${JSON.stringify(key.familyId)}`;
    case "Repository":
      return `2:${JSON.stringify(key.repository)}`;
    case "Creation":
      return `3:${JSON.stringify([key.repository, key.branch])}`;
  }
}
