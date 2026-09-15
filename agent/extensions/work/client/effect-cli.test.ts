import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { StorageFailure } from "../domain/index.ts";
import type {
  DurableOperation,
  OperationHandle,
  StartOperationRequest,
} from "../infrastructure/rpc/index.ts";
import type { StorageMaintenance } from "../infrastructure/storage/index.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import {
  EFFECT_CLI_EXIT,
  EFFECT_CLI_PROVISION_TIMEOUT_MS,
  runEffectPiWorkCli,
  type EffectCliDependencies,
} from "./effect-cli.ts";

const temporaryPaths = new Set<string>();

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pi-work-cli-"));
  temporaryPaths.add(home);
  await mkdir(join(home, "work"));
  await writeFile(
    join(home, "work", "config.json"),
    `${JSON.stringify({
      version: 2,
      workBase: "/work",
      policies: {
        defaults: {
          "repository.clone": "allow",
          "topic.create-worktree": "allow",
          "topic.run-setup": "allow",
          "terminal.open": "allow",
          "agent.open": "allow",
          "agent.reset": "allow",
          "topic.delete": "allow",
        },
        repositories: {},
        topics: {},
      },
      repositories: {},
    })}\n`,
  );
  return home;
}

afterEach(async () => {
  await Promise.all([...temporaryPaths].map((path) => rm(path, { recursive: true, force: true })));
  temporaryPaths.clear();
});

function operation(
  state: DurableOperation["state"],
  phase: string = state,
  value: unknown = { topicId: "123e4567-e89b-42d3-a456-426614174001", state: "ready" },
): DurableOperation {
  return {
    id: "123e4567-e89b-42d3-a456-426614174002",
    clientId: "123e4567-e89b-42d3-a456-426614174003",
    requestId: "123e4567-e89b-42d3-a456-426614174004",
    topicId: "123e4567-e89b-42d3-a456-426614174001",
    state,
    phase,
    input: { version: 1, kind: "topic.provision", value: {} },
    ...(state === "running" || state === "awaiting-confirmation"
      ? {}
      : { result: { version: 1, status: state, value } }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 1,
  } as unknown as DurableOperation;
}

async function git(checkout: string, ...args: string[]): Promise<void> {
  const process = Bun.spawn(["git", "-C", checkout, ...args], { stdout: "ignore", stderr: "pipe" });
  if ((await process.exited) !== 0) {
    throw new Error(await new Response(process.stderr).text());
  }
}

class FakeClient {
  readonly clientId = "123e4567-e89b-42d3-a456-426614174003" as WorkClientRuntime["clientId"];
  disposed = 0;
  confirmations = 0;
  rejections = 0;
  readonly requests: StartOperationRequest[] = [];
  snapshotValue: unknown = { durable: { topics: [] } };
  handle: OperationHandle = {
    id: "123e4567-e89b-42d3-a456-426614174002" as OperationHandle["id"],
    state: "running",
  };
  current = operation("running");
  terminal: Promise<DurableOperation> = Promise.resolve(operation("succeeded"));
  cancellationResult = operation("running");
  cancellationRequests = 0;

  runtime(): WorkClientRuntime {
    return {
      clientId: this.clientId,
      snapshot: async () => this.snapshotValue,
      startOperation: async (request: StartOperationRequest) => {
        this.requests.push(request);
        return this.handle;
      },
      getOperation: async () => this.current,
      awaitOperation: async () => this.terminal,
      requestOperationCancellation: async () => {
        this.cancellationRequests += 1;
        return { confirmation: "one-use-authority" };
      },
      confirmOperation: async () => {
        this.confirmations += 1;
        return this.cancellationResult;
      },
      rejectOperation: async () => {
        this.rejections += 1;
        return operation("cancelled", "rejected", { reason: "confirmation-rejected" });
      },
      dispose: async () => {
        this.disposed += 1;
      },
    } as unknown as WorkClientRuntime;
  }
}

async function harness(client = new FakeClient(), overrides: EffectCliDependencies = {}) {
  let stdout = "";
  let stderr = "";
  const home = await temporaryHome();
  return {
    client,
    dependencies: {
      home,
      runtime: join(home, "runtime"),
      cwd: "/current/checkout",
      makeClient: () => client.runtime(),
      requestId: () => "123e4567-e89b-42d3-a456-426614174004",
      onSignal: () => () => undefined,
      writeStdout: (text: string) => {
        stdout += text;
      },
      writeStderr: (text: string) => {
        stderr += text;
      },
      ...overrides,
    } satisfies EffectCliDependencies,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

const rootArgs = [
  "topic",
  "create",
  "--name",
  "My contribution",
  "--repository",
  "LedgerHQ/revault",
] as const;

describe("Effect Topic creation CLI", () => {
  test("rejects unknown, duplicate, missing, and incompatible options before connection", async () => {
    for (const args of [
      ["topic", "create", "--name", "Topic", "--unknown", "x"],
      ["topic", "create", "--name", "One", "--name", "Two"],
      ["topic", "create", "--name"],
      ["topic", "create-child", "--name", "Child", "--start-point", "HEAD", "--repository", "a/b"],
    ]) {
      let connections = 0;
      let stderr = "";
      expect(
        await runEffectPiWorkCli(args, {
          home: "/does/not/matter",
          makeClient: () => {
            connections += 1;
            return new FakeClient().runtime();
          },
          writeStderr: (text) => {
            stderr += text;
          },
        }),
      ).toBe(EFFECT_CLI_EXIT.usage);
      expect(connections).toBe(0);
      expect(stderr).toContain("Usage: pi-work topic create");
    }
  });

  test("uses the six-hour CLI wait and emits one versioned JSON object", async () => {
    const item = await harness();
    expect(await runEffectPiWorkCli([...rootArgs, "--json"], item.dependencies)).toBe(
      EFFECT_CLI_EXIT.success,
    );
    expect(item.client.disposed).toBe(1);
    expect(item.stdout().trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(item.stdout())).toMatchObject({ version: 2, status: "succeeded" });
    expect(EFFECT_CLI_PROVISION_TIMEOUT_MS).toBe(6 * 60 * 60 * 1_000);
    expect(item.stderr()).toContain("Connecting to pi-workd.");
  });

  test("maps the child flags and current checkout through the child planning path", async () => {
    const item = await harness();
    const checkout = join(item.dependencies.home!, "checkout");
    await mkdir(checkout);
    await git(checkout, "init", "--initial-branch=main");
    await git(checkout, "config", "user.email", "cli-test@example.com");
    await git(checkout, "config", "user.name", "CLI Test");
    await git(checkout, "remote", "add", "origin", "https://github.com/LedgerHQ/revault.git");
    await writeFile(join(checkout, "README.md"), "test\n");
    await git(checkout, "add", "README.md");
    await git(checkout, "commit", "-m", "test");
    const parentId = "123e4567-e89b-42d3-a456-426614174010";
    item.client.snapshotValue = {
      durable: {
        topics: [
          {
            topic: {
              id: parentId,
              name: "Parent",
              repository: "LedgerHQ/revault",
              branch: "main",
              setup: {
                state: "ready",
                repositoryAvailable: true,
                worktreeCreated: true,
                setupCommandsRun: true,
                completedCommandCount: 0,
              },
              worktreePath: checkout,
              mainAgent: { sessionId: "session", sessionFile: null },
              partition: 2,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        ],
      },
    };
    const exit = await runEffectPiWorkCli(
      [
        "topic",
        "create-child",
        "--name",
        "Continue change",
        "--start-point",
        "HEAD",
        "--parent-topic-id",
        parentId,
        "--source-checkout",
        checkout,
        "--branch",
        "continue-change",
      ],
      item.dependencies,
    );
    expect(exit).toBe(EFFECT_CLI_EXIT.success);
    expect(item.client.requests[0]?.input).toMatchObject({
      kind: "topic.provision",
      value: {
        attempt: "create-child",
        topic: {
          name: "Continue change",
          branch: "continue-change",
          parentTopicId: parentId,
          partition: 2,
        },
        startPoint: { sourceCheckout: checkout },
      },
    });
    expect(item.client.disposed).toBe(1);
  });

  test("confirms yes and rejects no on the same interactive client", async () => {
    const yesClient = new FakeClient();
    yesClient.handle = {
      id: yesClient.handle.id,
      state: "awaiting-confirmation",
      confirmation: "secret",
      confirmationText: "Clone LedgerHQ/revault?",
    };
    const yes = await harness(yesClient, { isInteractive: true, prompt: async () => "yes" });
    expect(await runEffectPiWorkCli(rootArgs, yes.dependencies)).toBe(EFFECT_CLI_EXIT.success);
    expect(yesClient.confirmations).toBe(1);
    expect(yesClient.rejections).toBe(0);
    expect(yesClient.disposed).toBe(1);

    const noClient = new FakeClient();
    noClient.handle = { ...yesClient.handle };
    const no = await harness(noClient, { isInteractive: true, prompt: async () => "no" });
    expect(await runEffectPiWorkCli(rootArgs, no.dependencies)).toBe(EFFECT_CLI_EXIT.denied);
    expect(noClient.confirmations).toBe(0);
    expect(noClient.rejections).toBe(1);
    expect(noClient.disposed).toBe(1);
  });

  test("never self-approves confirmation in JSON or headless mode", async () => {
    for (const json of [false, true]) {
      const client = new FakeClient();
      client.handle = {
        id: client.handle.id,
        state: "awaiting-confirmation",
        confirmation: "secret",
        confirmationText: "Create the Worktree?",
      };
      client.current = operation("awaiting-confirmation");
      const item = await harness(client, { isInteractive: false });
      expect(
        await runEffectPiWorkCli([...rootArgs, ...(json ? ["--json"] : [])], item.dependencies),
      ).toBe(EFFECT_CLI_EXIT.confirmationRequired);
      expect(client.confirmations).toBe(0);
      expect(client.rejections).toBe(0);
      expect(client.disposed).toBe(1);
      if (json) {
        expect(JSON.parse(item.stdout())).toMatchObject({
          version: 2,
          status: "confirmation-required",
          confirmationText: "Create the Worktree?",
        });
      }
    }
  });

  test("timeout and Ctrl-C stop only the wait and always dispose the client", async () => {
    const timeoutClient = new FakeClient();
    timeoutClient.terminal = new Promise(() => undefined);
    const timeout = await harness(timeoutClient, { provisionTimeoutMs: 1 });
    expect(await runEffectPiWorkCli(rootArgs, timeout.dependencies)).toBe(EFFECT_CLI_EXIT.timeout);
    expect(timeoutClient.disposed).toBe(1);

    let signal: (() => void) | undefined;
    const cancelledClient = new FakeClient();
    cancelledClient.terminal = new Promise(() => undefined);
    const cancelled = await harness(cancelledClient, {
      onSignal: (handler) => {
        signal = handler;
        return () => undefined;
      },
    });
    const pending = runEffectPiWorkCli([...rootArgs, "--json"], cancelled.dependencies);
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.();
    expect(await pending).toBe(EFFECT_CLI_EXIT.cancelled);
    expect(cancelledClient.disposed).toBe(1);
    expect(JSON.parse(cancelled.stdout())).toMatchObject({ status: "error" });
  });
});

describe("Effect operation and storage CLI", () => {
  test("rejects all invalid public syntax before making resources", async () => {
    for (const args of [
      ["operation", "list", "extra"],
      ["operation", "show"],
      ["operation", "cancel", "123e4567-e89b-42d3-a456-426614174002"],
      ["operation", "list", "--json", "--json"],
      ["storage", "backup", "--confirm"],
      ["storage", "verify", "relative/backup"],
      ["storage", "restore", "/exact/backup"],
      ["storage", "restore", "/exact/backup", "--confirm", "--confirm"],
    ]) {
      let clients = 0;
      let maintenanceCalls = 0;
      const maintenance: StorageMaintenance = {
        backup: () => {
          maintenanceCalls += 1;
          return Effect.die("must not run");
        },
        verify: () => {
          maintenanceCalls += 1;
          return Effect.die("must not run");
        },
        restore: () => {
          maintenanceCalls += 1;
          return Effect.die("must not run");
        },
      };
      expect(
        await runEffectPiWorkCli(args, {
          home: "/unused",
          makeClient: () => {
            clients += 1;
            return new FakeClient().runtime();
          },
          maintenance,
          writeStdout: () => undefined,
          writeStderr: () => undefined,
        }),
      ).toBe(EFFECT_CLI_EXIT.usage);
      expect(clients).toBe(0);
      expect(maintenanceCalls).toBe(0);
    }
  });

  test("lists active and terminal operations and shows stable human and JSON output", async () => {
    const client = new FakeClient();
    client.snapshotValue = {
      durable: { operations: [operation("succeeded"), operation("running")] },
    };
    const human = await harness(client);
    expect(await runEffectPiWorkCli(["operation", "list"], human.dependencies)).toBe(0);
    expect(human.stdout()).toContain("\trunning\trunning\t");
    expect(human.stdout()).toContain("\tsucceeded\tsucceeded\t");
    expect(client.disposed).toBe(1);

    const shown = await harness();
    expect(
      await runEffectPiWorkCli(
        ["operation", "show", "123e4567-e89b-42d3-a456-426614174002", "--json"],
        shown.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(shown.stdout())).toMatchObject({
      version: 2,
      status: "ok",
      operation: { state: "running", phase: "running" },
    });
    expect(shown.client.disposed).toBe(1);
  });

  test("uses one cancellation authority and distinguishes all terminal outcomes", async () => {
    for (const [result, status, exit] of [
      [operation("running"), "cancellation-requested", 0],
      [operation("cancelled"), "cancellation-completed", 0],
      [operation("succeeded"), "operation-completed", 0],
      [operation("failed"), "cancellation-failed", 1],
      [
        operation("cancelled", "expired", { reason: "confirmation-expired" }),
        "confirmation-expired",
        4,
      ],
      [
        operation("cancelled", "rejected", { reason: "confirmation-rejected" }),
        "confirmation-rejected",
        4,
      ],
    ] as const) {
      const client = new FakeClient();
      client.cancellationResult = result;
      const item = await harness(client);
      expect(
        await runEffectPiWorkCli(
          ["operation", "cancel", "123e4567-e89b-42d3-a456-426614174002", "--confirm", "--json"],
          item.dependencies,
        ),
      ).toBe(exit);
      expect(JSON.parse(item.stdout()).status).toBe(status);
      expect(client.cancellationRequests).toBe(1);
      expect(client.confirmations).toBe(1);
      expect(client.disposed).toBe(1);
    }
  });

  test("reports storage checks without content and releases its signal handler", async () => {
    let removed = 0;
    const maintenance: StorageMaintenance = {
      backup: () => Effect.succeed({ status: "created", path: "/private/backup" }),
      verify: (path) =>
        Effect.succeed({
          path,
          kind: "daily",
          createdAt: "2026-01-01T00:00:00.000Z",
          storageSchemaVersion: 2,
        }),
      restore: (backupPath) =>
        Effect.succeed({
          backupPath,
          databasePath: "/private/work.db",
          configurationPath: "/private/config.json",
        }),
    };
    const item = await harness(new FakeClient(), {
      maintenance,
      onSignal: () => () => {
        removed += 1;
      },
    });
    expect(
      await runEffectPiWorkCli(
        ["storage", "verify", "/private/backup", "--json"],
        item.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(item.stdout())).toMatchObject({
      version: 2,
      status: "backup-verified",
      checks: { checksum: "ok", sqlite: "ok", schema: "ok", graph: "ok" },
    });
    expect(item.stdout()).not.toContain("private content");
    expect(removed).toBe(1);
  });

  test("reports backup and restore results and cleans up after an injected failure", async () => {
    let backupCalls = 0;
    let finalized = 0;
    const maintenance: StorageMaintenance = {
      backup: () =>
        Effect.sync(() => {
          backupCalls += 1;
          return backupCalls === 1
            ? ({ status: "created", path: "/private/backup" } as const)
            : ({ status: "not-eligible" } as const);
        }),
      verify: () =>
        Effect.fail(
          new StorageFailure({
            reason: "integrity",
            message: "Verification failed safely.",
            internalCause: undefined,
          }),
        ).pipe(Effect.ensuring(Effect.sync(() => (finalized += 1)))),
      restore: (backupPath) =>
        Effect.succeed({
          backupPath,
          databasePath: "/private/work.db",
          configurationPath: "/private/config.json",
        }),
    };

    const created = await harness(new FakeClient(), { maintenance });
    expect(await runEffectPiWorkCli(["storage", "backup", "--json"], created.dependencies)).toBe(0);
    expect(JSON.parse(created.stdout()).status).toBe("backup-created");

    const notNeeded = await harness(new FakeClient(), { maintenance });
    expect(await runEffectPiWorkCli(["storage", "backup", "--json"], notNeeded.dependencies)).toBe(
      0,
    );
    expect(JSON.parse(notNeeded.stdout()).status).toBe("backup-not-needed");

    const restored = await harness(new FakeClient(), { maintenance });
    expect(
      await runEffectPiWorkCli(
        ["storage", "restore", "/private/backup", "--confirm", "--json"],
        restored.dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(restored.stdout()).status).toBe("backup-restored");

    const failed = await harness(new FakeClient(), { maintenance });
    expect(
      await runEffectPiWorkCli(
        ["storage", "verify", "/private/backup", "--json"],
        failed.dependencies,
      ),
    ).toBe(1);
    expect(JSON.parse(failed.stdout())).toMatchObject({
      version: 2,
      status: "error",
      message: "Verification failed safely.",
    });
    expect(failed.stderr()).toBe("pi-work: Verification failed safely.\n");
    expect(finalized).toBe(1);
  });
});
