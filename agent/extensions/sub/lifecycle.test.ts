import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChildDelegationLifecycle, CHILD_RESULT_WARNING } from "./lifecycle.ts";
import {
  type DelegationJobStatus,
  type DelegationJobStatusRecord,
  completeDelegationJob,
  pathExists,
  readJobStatus,
  resultPath,
  transitionJobStatus,
  validateDelegationJobStatusRecord,
  writeJobStatus,
} from "./mailbox.ts";

const temporaryDirectories: string[] = [];
const jobId = "job-123";
const createdAt = "2026-07-02T10:00:00.000Z";

async function makeJob(): Promise<string> {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-sub-lifecycle-"));
  temporaryDirectories.push(jobDir);
  await writeJobStatus(jobDir, baseStatus());
  return jobDir;
}

function baseStatus(): DelegationJobStatusRecord {
  return {
    status: "created",
    jobId,
    createdAt,
    updatedAt: createdAt,
    parentSessionFile: "/tmp/parent-session.jsonl",
    handoffMode: "fork",
    skillName: "review",
    forkSessionFile: "/tmp/fork-session.jsonl",
  };
}

function durableStatus(status: DelegationJobStatus): DelegationJobStatusRecord {
  const record = baseStatus();
  if (status === "created") return record;
  const at = `2026-07-02T10:0${String(["launched", "thinking", "waiting", "completed", "launch-failed"].indexOf(status) + 1)}:00.000Z`;
  return {
    ...record,
    status,
    updatedAt: at,
    ...(status === "launched" ? { launchedAt: at } : {}),
    ...(status === "thinking" ? { thinkingAt: at } : {}),
    ...(status === "waiting" ? { waitingAt: at } : {}),
    ...(status === "completed" ? { completedAt: at, resultPath: "/tmp/result.md" } : {}),
    ...(status === "launch-failed" ? { failedAt: at, error: "kitty unavailable" } : {}),
  };
}

function lifecycle(jobDir: string, warnings: Array<string | undefined>, times: Date[]) {
  return new ChildDelegationLifecycle(
    { jobId, jobDir },
    { show: (message) => warnings.push(message) },
    () => times.shift() ?? new Date("2026-07-02T11:00:00.000Z"),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("Delegation Job mailbox status", () => {
  test("validates each durable lifecycle state on reload", async () => {
    for (const status of [
      "created",
      "launched",
      "thinking",
      "waiting",
      "completed",
      "launch-failed",
    ] as const) {
      const jobDir = await makeJob();
      await writeJobStatus(jobDir, durableStatus(status));
      const warnings: Array<string | undefined> = [];

      const restored = await lifecycle(jobDir, warnings, []).restore();

      expect(restored.status).toBe(status);
      expect(warnings.at(-1)).toBe(status === "waiting" ? CHILD_RESULT_WARNING : undefined);
    }
  });

  test("rejects unknown and incomplete status records", () => {
    expect(() =>
      validateDelegationJobStatusRecord({ ...baseStatus(), status: "launch_failed" }),
    ).toThrow("Invalid Delegation Job status");
    expect(() =>
      validateDelegationJobStatusRecord({
        ...baseStatus(),
        status: "waiting",
        updatedAt: "2026-07-02T10:03:00.000Z",
      }),
    ).toThrow("waitingAt");
  });

  test("does not let a late parent launch write regress a thinking child", async () => {
    const jobDir = await makeJob();
    await transitionJobStatus(jobDir, "thinking", new Date("2026-07-02T10:01:00.000Z"));

    const record = await transitionJobStatus(
      jobDir,
      "launched",
      new Date("2026-07-02T10:02:00.000Z"),
    );

    expect(record.status).toBe("thinking");
    expect(record.launchedAt).toBe("2026-07-02T10:02:00.000Z");
    expect(record).toMatchObject({
      parentSessionFile: "/tmp/parent-session.jsonl",
      handoffMode: "fork",
      skillName: "review",
      forkSessionFile: "/tmp/fork-session.jsonl",
      createdAt,
      thinkingAt: "2026-07-02T10:01:00.000Z",
    });
  });
});

describe("child Delegation Job lifecycle", () => {
  test("moves from thinking to waiting without creating a Delegation Result", async () => {
    const jobDir = await makeJob();
    const warnings: Array<string | undefined> = [];
    const child = lifecycle(jobDir, warnings, [
      new Date("2026-07-02T10:01:00.000Z"),
      new Date("2026-07-02T10:02:00.000Z"),
    ]);

    expect((await child.agentStart()).status).toBe("thinking");
    expect((await child.agentSettled()).status).toBe("waiting");

    expect(await pathExists(resultPath(jobDir))).toBe(false);
    expect(warnings.at(-1)).toBe(CHILD_RESULT_WARNING);
    expect(await readJobStatus(jobDir)).toMatchObject({
      status: "waiting",
      thinkingAt: "2026-07-02T10:01:00.000Z",
      waitingAt: "2026-07-02T10:02:00.000Z",
      parentSessionFile: "/tmp/parent-session.jsonl",
      handoffMode: "fork",
    });
  });

  test("moves waiting work back to thinking when another turn starts", async () => {
    const jobDir = await makeJob();
    const warnings: Array<string | undefined> = [];
    const child = lifecycle(jobDir, warnings, [
      new Date("2026-07-02T10:01:00.000Z"),
      new Date("2026-07-02T10:02:00.000Z"),
      new Date("2026-07-02T10:03:00.000Z"),
    ]);
    await child.agentStart();
    await child.agentSettled();

    const record = await child.agentStart();

    expect(record.status).toBe("thinking");
    expect(record.waitingAt).toBe("2026-07-02T10:02:00.000Z");
    expect(record.thinkingAt).toBe("2026-07-02T10:03:00.000Z");
    expect(warnings.at(-1)).toBeUndefined();
  });

  test("sub_done completes the job and a later settle cannot regress it", async () => {
    const jobDir = await makeJob();
    const warnings: Array<string | undefined> = [];
    const child = lifecycle(jobDir, warnings, [new Date("2026-07-02T10:01:00.000Z")]);
    await child.agentStart();

    await completeDelegationJob(
      jobId,
      jobDir,
      "Compact result",
      new Date("2026-07-02T10:02:00.000Z"),
    );
    child.completed();
    const settled = await child.agentSettled();

    expect(settled.status).toBe("completed");
    expect(settled.completedAt).toBe("2026-07-02T10:02:00.000Z");
    expect(await fs.readFile(resultPath(jobDir), "utf8")).toBe("Compact result\n");
    expect(warnings.at(-1)).toBeUndefined();
  });
});
