import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import {
  AbsolutePath,
  Branch,
  ClientId,
  Repository,
  RequestId,
  TopicId,
  type DurableTopic,
} from "./domain/index.ts";
import { makeProductionWorkApplication } from "./daemon/production-application.ts";
import { ProcessPlatformLive } from "./infrastructure/process/index.ts";
import { createWorkPaths } from "./shared/paths.ts";
import {
  createCheckpointChild,
  createParentBranchScenario,
} from "./test-support/git-repository.ts";

const roots = new Set<string>();

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function privateFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function finalStorageFixture() {
  const parent = await mkdtemp(join(tmpdir(), "pi-work-final-storage-test-"));
  roots.add(parent);
  const rootPath = join(parent, "work");
  const runtime = join(parent, "runtime");
  await privateDirectory(rootPath);
  await privateDirectory(runtime);
  await privateFile(join(rootPath, "config.json"), {
    version: 2,
    policies: {
      defaults: {
        "repository.clone": "allow",
        "topic.create-worktree": "allow",
        "topic.run-setup": "allow",
        "terminal.open": "allow",
        "agent.open": "ask",
        "agent.reset": "ask",
        "topic.delete": "ask",
      },
      repositories: {},
      topics: {},
    },
    repositories: {},
  });
  return { parent, rootPath, runtime };
}

afterEach(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
    roots.delete(root);
  }
});

describe("final Effect control plane", () => {
  test("legacy modules and temporary migration entry points are absent", async () => {
    const deletedPaths = [
      "client/client.ts",
      "client/command.ts",
      "client/dashboard-component.ts",
      "daemon/entry.ts",
      "daemon/legacy-migration.ts",
      "daemon/process-runner.ts",
      "daemon/protocol.ts",
      "daemon/server.ts",
      "daemon/topic-service.ts",
      "infrastructure/storage/json-migration.ts",
      "shared/affiliation-store.ts",
      "shared/legacy-migration.ts",
      "shared/topic-store.ts",
      "topic-agent/reporter.ts",
    ];
    for (const path of deletedPaths) {
      expect(await Bun.file(join("agent/extensions/work", path)).exists()).toBe(false);
    }

    const cli = await readFile("agent/extensions/work/client/effect-cli.ts", "utf8");
    const daemon = await readFile("agent/extensions/work/daemon/effect-entry.ts", "utf8");
    const systemd = await readFile("agent/extensions/work/client/systemd.ts", "utf8");
    expect(cli).not.toContain("storage migrate");
    expect(daemon).not.toContain("verifyProductionCutoverStorage");
    expect(systemd).not.toContain("client.ping");
  });

  test("production code follows dependency and capability ownership rules", async () => {
    const deletedImports = [
      "/json-migration.ts",
      "/legacy-migration.ts",
      "/process-runner.ts",
      "/topic-store.ts",
      "/affiliation-store.ts",
    ];
    const timerExceptions = new Set([
      "client/operation-adapter.ts",
      "client/systemd.ts",
      "infrastructure/rpc/runtime.ts",
    ]);
    const glob = new Bun.Glob("**/*.ts");
    for await (const relative of glob.scan({ cwd: "agent/extensions/work", absolute: false })) {
      if (relative.endsWith(".test.ts") || relative.startsWith("test-support/")) continue;
      const source = await readFile(join("agent/extensions/work", relative), "utf8");

      for (const deleted of deletedImports) expect(source).not.toContain(deleted);
      expect(source).not.toMatch(/from\s+["']effect["']/);

      if (relative.startsWith("domain/")) {
        expect(source).not.toMatch(
          /from\s+["'](?:node:|bun:|\.\.\/(?:application|client|daemon|infrastructure|topic-agent))/,
        );
        expect(source).not.toMatch(/from\s+["']effect\/(?!Schema["'])/);
      }
      if (relative.startsWith("application/")) {
        expect(source).not.toMatch(
          /from\s+["'](?:\.\.\/\.\.\/(?:client|daemon)|@earendil-works\/pi-)/,
        );
      }

      const ownsSql = relative.startsWith("infrastructure/storage/");
      if (!ownsSql) {
        expect(source).not.toContain("effect/unstable/sql/SqlClient");
        expect(source).not.toContain('from "bun:sqlite"');
      }
      if (relative !== "infrastructure/process/process-executor.ts") {
        expect(source).not.toContain("node:child_process");
      }
      if (relative !== "infrastructure/rpc/runtime.ts") {
        expect(source).not.toContain("node:net");
      }
      if (!timerExceptions.has(relative)) {
        expect(source).not.toMatch(/\bset(?:Timeout|Interval)\s*\(/);
      }
    }

    const entry = await readFile("agent/extensions/work/index.ts", "utf8");
    expect(entry).not.toMatch(/export \* from ["'].+runtime/);
    for (const adapter of [
      "client/effect-command.ts",
      "client/effect-tools.ts",
      "topic-agent/effect-reporter.ts",
    ]) {
      const source = await readFile(join("agent/extensions/work", adapter), "utf8");
      expect(source).not.toMatch(/import \{[^}]*makeWorkClientRuntime[^}]*\} from/);
    }
  });

  test("starts from SQLite and ignores old live JSON paths without changing the backup", async () => {
    const fixture = await finalStorageFixture();
    const oldTopic = join(fixture.rootPath, "topics", "obsolete", "topic.json");
    const oldAffiliations = join(fixture.rootPath, "affiliations.json");
    const backupSentinel = join(fixture.rootPath, "backups", "original-import", "sentinel");
    await privateDirectory(join(fixture.rootPath, "topics", "obsolete"));
    await privateFile(oldTopic, { invalid: "old input must stay ignored" });
    await privateFile(oldAffiliations, { invalid: "old input must stay ignored" });
    await privateDirectory(join(fixture.rootPath, "backups", "original-import"));
    await writeFile(backupSentinel, "untouched\n", { mode: 0o600 });

    const paths = createWorkPaths({ home: fixture.parent, runtime: fixture.runtime });
    const snapshot = await Effect.runPromise(
      Effect.scoped(
        makeProductionWorkApplication(paths, {
          runtimeDirectory: fixture.runtime,
          socketPath: paths.socket,
          lockPath: join(fixture.runtime, "pi-workd.lock"),
        }).pipe(Effect.flatMap((application) => application.state.snapshot)),
      ).pipe(Effect.provide(ProcessPlatformLive), Effect.provide(BunFileSystem.layer)),
    );

    expect(snapshot.durable.topics).toEqual([]);
    expect(await readFile(backupSentinel, "utf8")).toBe("untouched\n");
    const database = new Database(join(fixture.rootPath, "work.db"), { readonly: true });
    expect(database.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    database.close();
  });

  test("activates a provisioned child and makes it the Parent Topic Integration Target", async () => {
    const fixture = await finalStorageFixture();
    const scenario = await createParentBranchScenario(fixture.parent, { checkpointCount: 2 });
    await scenario.repository.git("remote", "add", "origin", "https://github.com/owner/repo.git");
    const childBranch = "checkpoint";
    const childWorktree = join(fixture.parent, "checkpoint-worktree");
    await createCheckpointChild(scenario.repository, {
      branch: childBranch,
      startPoint: scenario.checkpoints[0]!,
      worktreePath: childWorktree,
    });
    await privateFile(join(fixture.rootPath, "config.json"), {
      version: 2,
      workBase: fixture.parent,
      policies: {
        defaults: {
          "repository.clone": "allow",
          "topic.create-worktree": "allow",
          "topic.run-setup": "allow",
          "terminal.open": "allow",
          "agent.open": "ask",
          "agent.reset": "ask",
          "topic.delete": "ask",
        },
        repositories: {},
        topics: {},
      },
      repositories: {
        "owner/repo": {
          basePath: scenario.repository.path,
          integrationBranch: scenario.integrationBranch,
          setupCommands: [],
        },
      },
    });

    const paths = createWorkPaths({ home: fixture.parent, runtime: fixture.runtime });
    const lease = {
      runtimeDirectory: fixture.runtime,
      socketPath: paths.socket,
      lockPath: join(fixture.runtime, "pi-workd.lock"),
    };
    await Effect.runPromise(
      Effect.scoped(makeProductionWorkApplication(paths, lease)).pipe(
        Effect.provide(ProcessPlatformLive),
        Effect.provide(BunFileSystem.layer),
      ),
    );

    const parentId = TopicId.make("10000000-0000-4000-8000-000000000001");
    const childId = TopicId.make("10000000-0000-4000-8000-000000000002");
    const now = "2026-01-01T00:00:00.000Z";
    const database = new Database(join(fixture.rootPath, "work.db"));
    database.run(
      `INSERT INTO topics (id, name, branch, repository, worktree_path, partition_number, created_at, updated_at)
       VALUES (?, 'Parent', ?, 'owner/repo', ?, 0, ?, ?)`,
      [parentId, scenario.parentBranch, scenario.repository.path, now, now],
    );
    database.run(
      `INSERT INTO topic_setup (topic_id, state, repository_available, worktree_created, setup_commands_run, completed_command_count)
       VALUES (?, 'ready', 1, 1, 1, 0)`,
      [parentId],
    );
    database.run(
      `INSERT INTO topic_relationships (topic_id, integration_target_kind, chain_state)
       VALUES (?, 'integration-branch', 'active')`,
      [parentId],
    );
    database.run(
      `INSERT INTO main_agent_identities (topic_id, session_id, session_file)
       VALUES (?, 'parent-session', NULL)`,
      [parentId],
    );
    database.close();

    const child: DurableTopic = {
      id: childId,
      name: "Checkpoint",
      branch: Branch.make(childBranch),
      repository: Repository.make("owner/repo"),
      setup: {
        state: "provisioning",
        repositoryAvailable: false,
        worktreeCreated: false,
        setupCommandsRun: false,
        completedCommandCount: 0,
      },
      worktreePath: null,
      mainAgent: { sessionId: "child-session", sessionFile: null },
      partition: 0,
      parentTopicId: parentId,
      originCommit: scenario.checkpoints[0] as DurableTopic["originCommit"],
      integrationTarget: { kind: "integration-branch" },
      chainState: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const result = await Effect.runPromise(
      Effect.scoped(
        makeProductionWorkApplication(paths, lease).pipe(
          Effect.flatMap((application) =>
            Effect.gen(function* () {
              const handle = yield* application.operations.start({
                clientId: ClientId.make("20000000-0000-4000-8000-000000000001"),
                requestId: RequestId.make("30000000-0000-4000-8000-000000000001"),
                fingerprint: "a".repeat(64),
                topicId: childId,
                input: {
                  version: 1,
                  kind: "topic.provision",
                  value: {
                    attempt: "create-child",
                    topic: child,
                    workBase: AbsolutePath.make(fixture.parent),
                    recipe: {
                      basePath: AbsolutePath.make(scenario.repository.path),
                      integrationBranch: Branch.make(scenario.integrationBranch),
                      setupCommands: [],
                    },
                    policies: {
                      "repository.clone": "allow",
                      "topic.create-worktree": "allow",
                      "topic.run-setup": "allow",
                      "terminal.open": "allow",
                      "agent.open": "ask",
                      "agent.reset": "ask",
                      "topic.delete": "ask",
                    },
                    startPoint: {
                      commit: child.originCommit!,
                      sourceCheckout: AbsolutePath.make(scenario.repository.path),
                    },
                  },
                },
              });
              const completed = yield* application.operations.await(handle.id);
              yield* application.ephemeralAction({ action: "refresh-integration" });
              yield* application.ephemeralAction({ action: "refresh-integration" });
              return { completed, snapshot: yield* application.state.snapshot };
            }),
          ),
        ),
      ).pipe(Effect.provide(ProcessPlatformLive), Effect.provide(BunFileSystem.layer)),
    );

    const parent = result.snapshot.durable.topics.find((row) => row.topic.id === parentId)?.topic;
    const checkpoint = result.snapshot.durable.topics.find(
      (row) => row.topic.id === childId,
    )?.topic;
    const observation = result.snapshot.observed.topics.find(
      (row) => row.topicId === parentId,
    )?.value;
    expect(result.completed.result?.status).toBe("succeeded");
    expect(checkpoint?.chainState).toBe("active");
    expect(parent?.integrationTarget).toEqual({ kind: "topic", topicId: childId });
    expect(observation?.integrationStatus).toMatchObject({
      kind: "current",
      target: childBranch,
    });

    const stale = new Database(join(fixture.rootPath, "work.db"));
    stale.run(
      `UPDATE topic_relationships
       SET integration_target_kind = 'integration-branch', integration_target_topic_id = NULL
       WHERE topic_id = ?`,
      [parentId],
    );
    stale.run(`UPDATE topic_relationships SET chain_state = 'pending' WHERE topic_id = ?`, [
      childId,
    ]);
    stale.close();

    const recovered = await Effect.runPromise(
      Effect.scoped(
        makeProductionWorkApplication(paths, lease).pipe(
          Effect.flatMap((application) =>
            application
              .ephemeralAction({ action: "refresh-integration" })
              .pipe(
                Effect.andThen(application.ephemeralAction({ action: "refresh-integration" })),
                Effect.andThen(application.state.snapshot),
              ),
          ),
        ),
      ).pipe(Effect.provide(ProcessPlatformLive), Effect.provide(BunFileSystem.layer)),
    );
    const recoveredParent = recovered.durable.topics.find(
      (row) => row.topic.id === parentId,
    )?.topic;
    const recoveredChild = recovered.durable.topics.find((row) => row.topic.id === childId)?.topic;
    const recoveredStatus = recovered.observed.topics.find((row) => row.topicId === parentId)?.value
      ?.integrationStatus;
    expect(recoveredChild?.chainState).toBe("active");
    expect(recoveredParent?.integrationTarget).toEqual({ kind: "topic", topicId: childId });
    expect(recoveredStatus).toMatchObject({ kind: "current", target: childBranch });
  });
});
