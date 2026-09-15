import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * The 20-Topic baseline observes a peak of one process. Four keeps measured current work
 * responsive while it gives independent operations limited parallel headroom.
 */
export const LIVE_PROCESS_PERMIT_COUNT = 4;

export interface ProcessPermit {
  readonly capacity: number;
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Tests can select a small capacity and prove the bound without starting processes. */
export function makeProcessPermit(capacity: number): ProcessPermit {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("Process permit capacity must be a positive safe integer.");
  }
  const semaphore = Semaphore.makeUnsafe(capacity);
  return {
    capacity,
    withPermit: (effect) => semaphore.withPermit(effect),
  };
}

/** All default executors share this permit, including temporary Promise adapters. */
export const globalProcessPermit = makeProcessPermit(LIVE_PROCESS_PERMIT_COUNT);
