import { afterEach, describe, expect, test } from "bun:test";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Effect from "effect/Effect";
import { decodeAbsolutePath } from "../domain/index.ts";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_CONFIG_VERSION, makeWorkConfigurationService } from "./config.ts";

const temporaryPaths = new Set<string>();

async function fixture(): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-work-config-"));
  temporaryPaths.add(directory);
  await chmod(directory, 0o700);
  return { directory, path: join(directory, "config.json") };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryPaths].map(async (path) => {
      await rm(path, { force: true, recursive: true });
      temporaryPaths.delete(path);
    }),
  );
});

function configuration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: WORK_CONFIG_VERSION,
    workBase: "/home/test/work",
    policies: {
      defaults: {
        "repository.clone": "allow",
        "topic.create-worktree": "allow",
        "topic.run-setup": "allow",
        "terminal.open": "allow",
        "agent.open": "allow",
        "agent.reset": "ask",
        "topic.delete": "ask",
      },
      repositories: {},
      topics: {},
    },
    repositories: {
      "LedgerHQ/revault": {
        setupCommands: ["bun install"],
        basePath: "/home/test/revault",
        integrationBranch: "main",
      },
    },
    ...overrides,
  };
}

async function writePrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function service(path: string) {
  return Effect.runPromise(
    makeWorkConfigurationService(path).pipe(Effect.provide(BunFileSystem.layer)),
  );
}

describe("strict Work configuration", () => {
  test("rejects old versions and unknown fields with a bounded diagnostic", async () => {
    for (const value of [{ ...configuration(), version: 1 }, configuration({ surprise: true })]) {
      const { path } = await fixture();
      await writePrivate(path, value);
      const config = await service(path);
      const exit = await Effect.runPromiseExit(config.validateStartup);
      expect(exit._tag).toBe("Failure");
      const snapshot = await Effect.runPromise(config.display);
      expect(snapshot.configuration).toBeUndefined();
      expect(snapshot.diagnostic?.message.length).toBeLessThanOrEqual(200);
    }
  });

  test("rejects malformed values without permissive defaults", async () => {
    const { path } = await fixture();
    const source = configuration();
    const policies = source["policies"] as Record<string, unknown>;
    await writePrivate(path, {
      ...source,
      policies: {
        ...policies,
        defaults: {
          ...(policies["defaults"] as Record<string, unknown>),
          "repository.clone": "sometimes",
        },
      },
    });
    const config = await service(path);
    await expect(Effect.runPromise(config.loadForPolicyCommand)).rejects.toMatchObject({
      _tag: "ConfigurationFailure",
      reason: "invalid",
    });
    expect((await Effect.runPromise(config.display)).configuration).toBeUndefined();
  });

  test("retains the last valid display value but fails commands until an edit is valid", async () => {
    const { path } = await fixture();
    await writePrivate(path, configuration());
    const config = await service(path);
    const initial = await Effect.runPromise(config.validateStartup);

    await writePrivate(path, { ...configuration(), unknown: "bad edit" });
    await expect(Effect.runPromise(config.loadForPolicyCommand)).rejects.toMatchObject({
      _tag: "ConfigurationFailure",
      reason: "invalid",
    });
    expect((await Effect.runPromise(config.display)).configuration).toEqual(initial);

    await writePrivate(path, configuration({ workBase: "/home/test/new-work" }));
    const refreshed = await Effect.runPromise(config.refresh);
    expect(String(refreshed.workBase)).toBe("/home/test/new-work");
    expect((await Effect.runPromise(config.display)).diagnostic).toBeUndefined();
  });

  test("a read does not rewrite the strict file", async () => {
    const { path } = await fixture();
    const source = `${JSON.stringify(configuration())}\n`;
    await writeFile(path, source, { mode: 0o600 });
    await chmod(path, 0o600);
    const config = await service(path);
    await Effect.runPromise(config.validateStartup);
    expect(await readFile(path, "utf8")).toBe(source);
  });

  test("explicit writes are atomic and preserve private modes", async () => {
    const { directory, path } = await fixture();
    await writePrivate(path, configuration());
    const config = await service(path);
    const current = await Effect.runPromise(config.validateStartup);
    await Effect.runPromise(
      config.write({ ...current, workBase: decodeAbsolutePath("/home/test/written") }),
    );
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: WORK_CONFIG_VERSION,
      workBase: "/home/test/written",
    });
  });

  test("startup rejects missing configuration", async () => {
    const { path } = await fixture();
    const config = await service(path);
    await expect(Effect.runPromise(config.validateStartup)).rejects.toMatchObject({
      _tag: "ConfigurationFailure",
      reason: "missing",
    });
  });
});
