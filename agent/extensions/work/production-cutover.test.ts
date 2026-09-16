import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import { makeProductionWorkApplication } from "./daemon/production-application.ts";
import { ProcessPlatformLive } from "./infrastructure/process/index.ts";
import { createWorkPaths } from "./shared/paths.ts";

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
});
