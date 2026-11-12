/** Pure tracker for "unchanged re-read" detection. No I/O. */

export interface ReadSlice {
  mtimeMs: number;
  size: number;
  offset?: number | undefined;
  limit?: number | undefined;
}

export interface ReadRecord extends ReadSlice {
  turn: number;
  bytes: number;
}

export interface Unchanged {
  unchanged: true;
  firstTurn: number;
  bytes: number;
}

const key = (path: string, offset?: number, limit?: number) =>
  JSON.stringify([path, offset ?? null, limit ?? null]);

export class ReadTracker {
  private reads = new Map<string, ReadRecord & { path: string }>();

  /** Remember a successful read. `bytes` is the size of the result text. */
  record(path: string, r: ReadRecord): void {
    const k = key(path, r.offset, r.limit);
    const old = this.reads.get(k);
    // Keep the first turn while the file stays the same: the text is still at that place.
    const same = old && old.mtimeMs === r.mtimeMs && old.size === r.size;
    this.reads.set(k, { ...r, path, turn: same ? old.turn : r.turn });
  }

  /** Same path, mtime, size and slice as a recorded read: the result is still in context. */
  check(path: string, s: ReadSlice): Unchanged | undefined {
    const old = this.reads.get(key(path, s.offset, s.limit));
    if (!old || old.mtimeMs !== s.mtimeMs || old.size !== s.size) return undefined;
    return { unchanged: true, firstTurn: old.turn, bytes: old.bytes };
  }

  /** Call on compaction, session start, switch and tree navigation. */
  reset(): void {
    this.reads.clear();
  }
}
