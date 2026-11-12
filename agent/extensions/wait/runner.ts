import type { WaitSpec } from "./spec.ts";

/** Local waits: process exit, HTTP ready, short timers. All I/O is injected, so tests use fake time. */
export interface RunnerDeps {
  now(): number;
  isAlive(pid: number): boolean;
  /** True when the URL answers with a non-5xx status. Must not throw. */
  probeHttp(url: string): Promise<boolean>;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  fire(wait: LocalWait, message: string): void;
}

export interface LocalWait {
  id: string;
  spec: Extract<WaitSpec, { event: "time" | "process.exit" | "http.ready" }>;
  createdAt: number;
  deadline: number;
  note?: string;
}

export const MAX_LOCAL_WAITS = 10;
export const DEFAULT_TIMEOUT_MS = 6 * 60 * 60_000;
export const TICK_MS = 2_000;

const minutes = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

export class LocalRunner {
  private readonly waits = new Map<string, LocalWait>();
  private readonly busy = new Set<string>();
  private handle: unknown;
  private seq = 0;

  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  add(spec: LocalWait["spec"], opts: { note?: string; timeoutMs?: number } = {}): LocalWait {
    if (this.waits.size >= MAX_LOCAL_WAITS) {
      throw new Error(
        `too many active waits (max ${MAX_LOCAL_WAITS}); cancel one with wait_cancel`,
      );
    }
    const now = this.deps.now();
    const wait: LocalWait = {
      id: `w${++this.seq}`,
      spec,
      createdAt: now,
      deadline: now + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      ...(opts.note === undefined ? {} : { note: opts.note }),
    };
    this.waits.set(wait.id, wait);
    this.handle ??= this.deps.setInterval(() => void this.tick(), TICK_MS);
    return wait;
  }

  cancel(id: string): boolean {
    const existed = this.waits.delete(id);
    this.stopTimerIfIdle();
    return existed;
  }

  list(): LocalWait[] {
    return [...this.waits.values()];
  }

  stopAll(): void {
    this.waits.clear();
    this.stopTimerIfIdle();
  }

  /** One polling pass. Public so tests can drive it. */
  async tick(): Promise<void> {
    const now = this.deps.now();
    for (const wait of this.list()) {
      if (this.busy.has(wait.id)) continue;
      this.busy.add(wait.id);
      try {
        const message = await this.check(wait, now);
        if (message !== undefined && this.waits.delete(wait.id)) this.deps.fire(wait, message);
      } finally {
        this.busy.delete(wait.id);
      }
    }
    this.stopTimerIfIdle();
  }

  private async check(wait: LocalWait, now: number): Promise<string | undefined> {
    const age = minutes(now - wait.createdAt);
    const spec = wait.spec;
    let done = false;
    let what = "";
    if (spec.event === "time") {
      done = now >= wait.createdAt + spec.afterMs;
      what = `Timer of ${minutes(spec.afterMs)} is over.`;
    } else if (spec.event === "process.exit") {
      done = !this.deps.isAlive(spec.pid);
      what = `Process ${spec.label} (pid ${spec.pid}) exited after ${age}.`;
    } else {
      done = await this.deps.probeHttp(spec.url);
      what = `${spec.url} answers after ${age}.`;
    }
    if (done) return wait.note ? `${what} Note: ${wait.note}` : what;
    if (now >= wait.deadline)
      return `Wait ${wait.id} gave up after ${age}: ${spec.event} did not happen.`;
    return undefined;
  }

  private stopTimerIfIdle(): void {
    if (this.waits.size === 0 && this.handle !== undefined) {
      this.deps.clearInterval(this.handle);
      this.handle = undefined;
    }
  }
}
