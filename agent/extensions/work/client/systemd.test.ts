import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { type WorkClient } from "./client.ts";
import {
  SystemdWorkdManager,
  findBunExecutable,
  generateSystemdUnit,
  type ProcessRunner,
  type SystemdPaths,
} from "./systemd.ts";

const temporaryDirectories: string[] = [];

async function paths(): Promise<SystemdPaths> {
  const home = await mkdtemp(join(tmpdir(), "pi-workd-systemd-test-"));
  temporaryDirectories.push(home);
  return {
    unitPath: join(home, ".config/systemd/user/pi-workd.service"),
    bunExecutable: join(home, "bun executable"),
    nodeExecutable: join(home, "node executable"),
    piExecutable: join(home, "pi executable"),
    ghExecutable: join(home, "gh executable"),
    daemonEntryPath: join(home, "daemon%entry.ts"),
    socketPath: join(home, "pi-workd.sock"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("systemd unit management", () => {
  test("runs the client process adapter when Pi has no Bun global", async () => {
    const moduleUrl = new URL("./systemd.ts", import.meta.url).href;
    const script = `const { runProcess } = await import(${JSON.stringify(moduleUrl)}); const result = await runProcess("true", []); if (result.code !== 0) process.exit(result.code);`;
    const child = spawn(
      "node",
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      {
        env: process.env,
        stdio: "pipe",
      },
    );
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    child.stderr.setEncoding("utf8");
    let stderr = "";
    for await (const chunk of child.stderr) stderr += chunk;
    const code = await closed;

    expect(code, stderr).toBe(0);
  });

  test("finds Bun from the client PATH instead of using the Pi executable", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-workd-bun-test-"));
    temporaryDirectories.push(home);
    const bin = join(home, "tools");
    const executable = join(bin, "bun");
    await mkdir(bin);
    await writeFile(executable, "");
    await chmod(executable, 0o700);

    expect(findBunExecutable(home, { PATH: bin })).toBe(executable);
  });

  test("generates stable, argument-safe service content without enabling it", async () => {
    const value = await paths();
    const first = generateSystemdUnit(value);
    expect(generateSystemdUnit(value)).toBe(first);
    expect(first).toContain(`Environment="PI_WORK_NODE_EXECUTABLE=${value.nodeExecutable}"`);
    expect(first).toContain(`Environment="PI_WORK_PI_EXECUTABLE=${value.piExecutable}"`);
    expect(first).toContain(`Environment="PI_WORK_GH_EXECUTABLE=${value.ghExecutable}"`);
    expect(first).toContain(`ExecStart="${value.bunExecutable}"`);
    expect(first).toContain("daemon%%entry.ts");
    expect(first).not.toContain("WantedBy=multi-user.target");
    expect(first).not.toContain("systemctl enable");
  });

  test("does not rewrite or reload an unchanged unit", async () => {
    const value = await paths();
    const calls: string[][] = [];
    const run: ProcessRunner = async (_command, args) => {
      calls.push([...args]);
      return { code: 0, stdout: "", stderr: "" };
    };
    const manager = new SystemdWorkdManager({ paths: value, run });
    expect(await manager.install()).toEqual({ changed: true });
    expect(calls).toEqual([["--user", "daemon-reload"]]);
    const content = await readFile(value.unitPath, "utf8");
    expect(content).toBe(generateSystemdUnit(value));

    calls.length = 0;
    expect(await manager.install()).toEqual({ changed: false });
    expect(calls).toEqual([]);
  });

  test("uses a bounded startup deadline", async () => {
    const value = await paths();
    let clock = 0;
    let attempts = 0;
    const manager = new SystemdWorkdManager({
      paths: value,
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      environment: {},
      connect: async () => {
        attempts += 1;
        throw new Error("socket unavailable");
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
      startupTimeoutMs: 250,
      attemptTimeoutMs: 10,
    });
    await expect(manager.ensureConnected()).rejects.toThrow("Timed out while starting pi-workd");
    expect(clock).toBe(250);
    expect(attempts).toBeGreaterThan(1);
  });

  test("reports daemon-reload and restart failures", async () => {
    const reloadPaths = await paths();
    const failed: ProcessRunner = async (_command, args) => ({
      code: 1,
      stdout: "",
      stderr: args.at(-1) === "daemon-reload" ? "reload denied" : "restart denied",
    });
    const reloadManager = new SystemdWorkdManager({ paths: reloadPaths, run: failed });
    await expect(reloadManager.install()).rejects.toThrow("reload denied");

    const startPaths = await paths();
    await mkdir(dirname(startPaths.unitPath), { recursive: true });
    await writeFile(startPaths.unitPath, generateSystemdUnit(startPaths));
    const startManager = new SystemdWorkdManager({
      paths: startPaths,
      run: failed,
      environment: {},
      connect: async () => {
        throw new Error("not running");
      },
    });
    await expect(startManager.ensureConnected()).rejects.toThrow("restart denied");
  });

  test("restarts a stale daemon that cannot complete the current ping", async () => {
    const value = await paths();
    await mkdir(dirname(value.unitPath), { recursive: true });
    await writeFile(value.unitPath, generateSystemdUnit(value));
    const calls: string[][] = [];
    let restarted = false;
    const client = {
      ping: async () => ({ protocolVersion: 5, pid: 1 }),
      close: () => undefined,
    } as unknown as WorkClient;
    const manager = new SystemdWorkdManager({
      paths: value,
      run: async (_command, args) => {
        calls.push([...args]);
        if (args.includes("restart")) restarted = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      environment: {},
      connect: async () => {
        if (!restarted) throw new Error("Work daemon uses an unsupported protocol version.");
        return client;
      },
    });

    expect(await manager.ensureConnected()).toBe(client);
    expect(calls).toEqual([["--user", "restart", "pi-workd.service"]]);
  });

  test("forwards GitHub credentials into the user manager before it starts the daemon", async () => {
    const value = await paths();
    await mkdir(dirname(value.unitPath), { recursive: true });
    await writeFile(value.unitPath, generateSystemdUnit(value));
    const calls: string[][] = [];
    let restarted = false;
    const client = {
      ping: async () => ({ protocolVersion: 7, pid: 1 }),
      close: () => undefined,
    } as unknown as WorkClient;
    const manager = new SystemdWorkdManager({
      paths: value,
      run: async (_command, args) => {
        calls.push([...args]);
        if (args.includes("restart")) restarted = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      environment: { GH_TOKEN: "ghp_test" },
      connect: async () => {
        if (!restarted) throw new Error("Work daemon uses an unsupported protocol version.");
        return client;
      },
    });

    expect(await manager.ensureConnected()).toBe(client);
    expect(calls).toEqual([
      ["--user", "import-environment", "GH_TOKEN"],
      ["--user", "restart", "pi-workd.service"],
    ]);
  });

  test("returns an already running client without systemd calls", async () => {
    const value = await paths();
    let calls = 0;
    const client = {
      ping: async () => ({ protocolVersion: 5, pid: 1 }),
      close: () => undefined,
    } as unknown as WorkClient;
    const manager = new SystemdWorkdManager({
      paths: value,
      run: async () => {
        calls += 1;
        return { code: 0, stdout: "", stderr: "" };
      },
      connect: async () => client,
    });
    expect(await manager.ensureConnected()).toBe(client);
    expect(calls).toBe(0);
  });
});
