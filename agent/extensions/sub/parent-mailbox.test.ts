import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DelegationJobRecord, DelegationResultRecord } from "./mailbox.ts";
import { SUB_CUSTOM_JOB, SUB_CUSTOM_RESULT, resultPath } from "./mailbox.ts";
import {
  ParentMailboxCoordinator,
  type ParentMailboxDependencies,
  type ParentMailboxTimer,
} from "./parent-mailbox.ts";

class FakeTimers implements ParentMailboxTimer {
  readonly handlers = new Map<number, () => void | Promise<void>>();
  private nextId = 1;

  setInterval(handler: () => void | Promise<void>): unknown {
    const id = this.nextId++;
    this.handlers.set(id, handler);
    return id;
  }

  clearInterval(timer: unknown): void {
    this.handlers.delete(timer as number);
  }

  async tick(): Promise<void> {
    await Promise.all([...this.handlers.values()].map((handler) => handler()));
  }
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sub-parent-mailbox-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

function job(overrides: Partial<DelegationJobRecord> = {}): DelegationJobRecord {
  return {
    jobId: "job-123",
    jobDir: path.join(tempDir, "job-123"),
    prompt: "Inspect the parser",
    cwd: tempDir,
    createdAt: "2026-07-03T10:00:00.000Z",
    parentSessionId: "parent-session",
    parentSessionFile: "/sessions/parent.jsonl",
    ...overrides,
  };
}

function jobEntry(record: DelegationJobRecord): unknown {
  return { type: "custom", customType: SUB_CUSTOM_JOB, data: record };
}

function importEntry(record: DelegationResultRecord): unknown {
  return { type: "custom", customType: SUB_CUSTOM_RESULT, data: record };
}

async function writeResult(record: DelegationJobRecord, result = "Parser review complete.") {
  await fs.mkdir(record.jobDir, { recursive: true });
  await fs.writeFile(resultPath(record.jobDir), result, "utf8");
}

function harness(overrides: Partial<ParentMailboxDependencies> = {}) {
  const timers = new FakeTimers();
  const imports: DelegationResultRecord[] = [];
  const deliveries: Array<{ record: DelegationResultRecord; content: string }> = [];
  const diagnostics: string[] = [];
  const dependencies: ParentMailboxDependencies = {
    identity: { sessionId: "parent-session", sessionFile: "/sessions/parent.jsonl" },
    appendImport: (record) => imports.push(record),
    deliverFollowUp: (record, content) => deliveries.push({ record, content }),
    readResult: async (record) => {
      try {
        return await fs.readFile(resultPath(record.jobDir), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    readLegacyParentSessionFile: async () => "/sessions/parent.jsonl",
    now: () => new Date("2026-07-03T10:01:00.000Z"),
    timers,
    diagnostic: (message) => diagnostics.push(message),
    truncateResult: (result) => result,
    ...overrides,
  };
  return {
    coordinator: new ParentMailboxCoordinator(dependencies),
    timers,
    imports,
    deliveries,
    diagnostics,
  };
}

describe("parent Job Mailbox coordinator", () => {
  test("delivers a completed result to an idle parent once and stops its timer", async () => {
    const record = job();
    await writeResult(record);
    const testHarness = harness();

    await testHarness.coordinator.restore([jobEntry(record)]);
    await testHarness.coordinator.pollNow();

    expect(testHarness.deliveries).toHaveLength(1);
    expect(testHarness.imports).toHaveLength(1);
    expect(testHarness.deliveries[0]?.content).toContain("Parser review complete.");
    expect(testHarness.timers.handlers.size).toBe(0);
  });

  test("queues one accepted follow-up while active and starts it after settle", async () => {
    const record = job();
    await writeResult(record);
    let active = true;
    const queued: Array<() => void> = [];
    let startedTurns = 0;
    const testHarness = harness({
      deliverFollowUp: () => {
        if (active) queued.push(() => startedTurns++);
        else startedTurns++;
      },
    });

    await testHarness.coordinator.restore([jobEntry(record)]);
    await testHarness.coordinator.pollNow();
    expect(queued).toHaveLength(1);
    expect(startedTurns).toBe(0);

    active = false;
    queued.shift()?.();
    expect(startedTurns).toBe(1);
  });

  test("survives reload before and after result creation without duplicate delivery", async () => {
    const record = job();
    const first = harness();
    await first.coordinator.restore([jobEntry(record)]);
    first.coordinator.stop();

    await writeResult(record);
    const second = harness();
    await second.coordinator.restore([jobEntry(record)]);
    const imported = second.imports[0]!;
    second.coordinator.stop();

    const third = harness();
    await third.coordinator.restore([jobEntry(record), importEntry(imported)]);
    await third.timers.tick();

    expect(second.deliveries).toHaveLength(1);
    expect(third.deliveries).toHaveLength(0);
  });

  test("keeps duplicate polls idempotent by Delegation Job ID", async () => {
    const record = job();
    const testHarness = harness();
    await testHarness.coordinator.restore([jobEntry(record)]);
    await writeResult(record);

    await Promise.all([
      testHarness.coordinator.pollNow(),
      testHarness.coordinator.pollNow(),
      testHarness.timers.tick(),
    ]);

    expect(testHarness.deliveries).toHaveLength(1);
    expect(testHarness.imports).toHaveLength(1);
  });

  test("does not let another session or a legacy child session claim a result", async () => {
    const foreign = job({ parentSessionId: "other-parent" });
    const legacyWithOwner = job({
      jobId: "legacy-job",
      jobDir: path.join(tempDir, "legacy-job"),
    });
    const {
      parentSessionId: _parentSessionId,
      parentSessionFile: _parentSessionFile,
      ...legacy
    } = legacyWithOwner;
    await writeResult(foreign);
    await writeResult(legacy);
    const testHarness = harness({
      readLegacyParentSessionFile: async () => "/sessions/original-parent.jsonl",
    });

    await testHarness.coordinator.restore([jobEntry(foreign), jobEntry(legacy)]);

    expect(testHarness.deliveries).toHaveLength(0);
    expect(testHarness.timers.handlers.size).toBe(0);
  });

  test("stops a pending read and all timers during session shutdown", async () => {
    const record = job();
    let finishRead: ((result: string) => void) | undefined;
    const testHarness = harness({
      readResult: () =>
        new Promise<string>((resolve) => {
          finishRead = resolve;
        }),
    });

    const restoring = testHarness.coordinator.restore([jobEntry(record)]);
    while (!finishRead) await Promise.resolve();
    testHarness.coordinator.stop();
    finishRead?.("Late result");
    await restoring;

    expect(testHarness.timers.handlers.size).toBe(0);
    expect(testHarness.deliveries).toHaveLength(0);
  });

  test("retries a transient read failure and bounds diagnostics", async () => {
    const record = job();
    let reads = 0;
    const testHarness = harness({
      readResult: async () => {
        reads++;
        if (reads <= 4) throw new Error(`temporary read failure ${reads}`);
        return "Recovered result";
      },
    });

    await testHarness.coordinator.restore([jobEntry(record)]);
    for (let attempt = 0; attempt < 4; attempt++) await testHarness.timers.tick();

    expect(testHarness.deliveries).toHaveLength(1);
    expect(testHarness.diagnostics).toHaveLength(3);
    expect(testHarness.diagnostics.every((message) => message.length <= 300)).toBe(true);
  });

  test("repairs the import entry from an accepted follow-up after reload", async () => {
    const record = job();
    await writeResult(record);
    const first = harness({
      appendImport: () => {
        throw new Error("session write busy");
      },
    });
    await first.coordinator.restore([jobEntry(record)]);
    const deliveredRecord = first.deliveries[0]!.record;
    first.coordinator.stop();

    const second = harness();
    await second.coordinator.restore([
      jobEntry(record),
      {
        type: "custom_message",
        customType: SUB_CUSTOM_RESULT,
        details: deliveredRecord,
      },
    ]);

    expect(second.deliveries).toHaveLength(0);
    expect(second.imports).toEqual([deliveredRecord]);
  });

  test("retries only the durable import entry after Pi accepts the follow-up", async () => {
    const record = job();
    await writeResult(record);
    let appendAttempts = 0;
    const imports: DelegationResultRecord[] = [];
    const testHarness = harness({
      appendImport: (resultRecord) => {
        appendAttempts++;
        if (appendAttempts === 1) throw new Error("session write busy");
        imports.push(resultRecord);
      },
    });

    await testHarness.coordinator.restore([jobEntry(record)]);
    await testHarness.timers.tick();

    expect(testHarness.deliveries).toHaveLength(1);
    expect(imports).toHaveLength(1);
    expect(testHarness.timers.handlers.size).toBe(0);
  });
});
