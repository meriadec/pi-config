import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkClient } from "../client/client.ts";
import {
  MAX_FRAME_BYTES,
  NdjsonDecoder,
  ProtocolError,
  WORK_PROTOCOL_VERSION,
  parseRequest,
} from "./protocol.ts";
import { WorkDaemon } from "./server.ts";

const temporaryDirectories: string[] = [];
const daemons: WorkDaemon[] = [];

async function temporarySocket(): Promise<{ directory: string; socket: string }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-workd-test-"));
  temporaryDirectories.push(directory);
  return { directory, socket: join(directory, "pi-workd.sock") };
}

async function startDaemon(): Promise<{ daemon: WorkDaemon; socket: string }> {
  const paths = await temporarySocket();
  const daemon = new WorkDaemon({ socketPath: paths.socket, runtimeDirectory: paths.directory });
  await daemon.start();
  daemons.push(daemon);
  return { daemon, socket: paths.socket };
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("NDJSON framing", () => {
  test("accepts split and combined frames", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.feed(Buffer.from('{"a":'))).toEqual([]);
    expect(decoder.feed(Buffer.from('1}\n{"b":2}\n'))).toEqual([
      { ok: true, text: '{"a":1}' },
      { ok: true, text: '{"b":2}' },
    ]);
  });

  test("bounds oversized frames and continues after their newline", () => {
    const decoder = new NdjsonDecoder();
    const first = decoder.feed(Buffer.alloc(MAX_FRAME_BYTES + 1, 97));
    expect(first).toHaveLength(1);
    expect(first[0]?.ok).toBe(false);
    expect(decoder.feed(Buffer.from('\n{"ok":true}\n'))).toEqual([
      { ok: true, text: '{"ok":true}' },
    ]);
  });
});

describe("work daemon", () => {
  test("accepts only the exact delegated-thinking action", () => {
    const request = (action: string): string =>
      JSON.stringify({
        version: WORK_PROTOCOL_VERSION,
        kind: "request",
        id: "delegation-state",
        clientId: "topic-agent",
        action,
      });

    expect(parseRequest(request("agent.thinking-sub"))).toMatchObject({
      action: "agent.thinking-sub",
    });
    expect(() => parseRequest(request("agent.thinking_sub"))).toThrow(ProtocolError);
    expect(() => parseRequest(request("agent.delegating"))).toThrow(ProtocolError);
  });

  test("validates the version 14 Topic creation contract", () => {
    const request = (input: Record<string, unknown>) =>
      JSON.stringify({
        version: WORK_PROTOCOL_VERSION,
        kind: "request",
        id: "create",
        clientId: "cli",
        action: "topic.create",
        input,
      });
    const basic = { name: "Topic", branch: "topic", repository: "acme/widgets" };
    expect(parseRequest(request(basic))).toMatchObject({ input: basic });
    const extended = {
      ...basic,
      startPoint: { commit: "a".repeat(40), sourceCheckout: "/source/widgets" },
    };
    expect(parseRequest(request(extended))).toMatchObject({ input: extended });

    for (const input of [
      { ...basic, unknown: true },
      { ...basic, startPoint: { ...extended.startPoint, unknown: true } },
      { ...basic, startPoint: { commit: "a".repeat(39), sourceCheckout: "/source" } },
      { ...basic, startPoint: { commit: "z".repeat(40), sourceCheckout: "/source" } },
      { ...basic, startPoint: { commit: "a".repeat(40), sourceCheckout: "relative" } },
      { ...basic, startPoint: { commit: "a".repeat(40), sourceCheckout: `/${"x".repeat(1_000)}` } },
    ]) {
      expect(() => parseRequest(request(input))).toThrow(ProtocolError);
    }
  });

  test("validates the child Topic creation contract", () => {
    const request = (input: Record<string, unknown>) =>
      JSON.stringify({
        version: WORK_PROTOCOL_VERSION,
        kind: "request",
        id: "create-child",
        clientId: "cli",
        action: "topic.create-child",
        input,
      });
    const startPoint = { commit: "a".repeat(40), sourceCheckout: "/source/widgets" };
    const basic = {
      parentTopicId: "123e4567-e89b-42d3-a456-426614174000",
      name: "First commit",
      startPoint,
    };
    expect(parseRequest(request(basic))).toMatchObject({ input: basic });
    expect(parseRequest(request({ ...basic, branch: "feat-first" }))).toMatchObject({
      input: { ...basic, branch: "feat-first" },
    });

    for (const input of [
      { ...basic, repository: "acme/widgets" },
      { ...basic, startPoint: undefined },
      { ...basic, startPoint: { ...startPoint, unknown: true } },
      { ...basic, startPoint: { commit: "z".repeat(40), sourceCheckout: "/source" } },
      { ...basic, startPoint: { commit: "a".repeat(40), sourceCheckout: "relative" } },
      { ...basic, name: "" },
      { ...basic, parentTopicId: "" },
    ]) {
      expect(() => parseRequest(request(input))).toThrow(ProtocolError);
    }
  });

  test("accepts empty and non-empty Topic Note requests", () => {
    const request = (note: unknown) =>
      JSON.stringify({
        version: WORK_PROTOCOL_VERSION,
        kind: "request",
        id: "set-note",
        clientId: "dashboard",
        action: "topic.set-note",
        topicId: "123e4567-e89b-42d3-a456-426614174000",
        note,
      });

    expect(parseRequest(request("waiting for Tom"))).toMatchObject({
      action: "topic.set-note",
      note: "waiting for Tom",
    });
    expect(parseRequest(request(""))).toMatchObject({ action: "topic.set-note", note: "" });
    expect(() => parseRequest(request(42))).toThrow(ProtocolError);
  });

  test("correlates requests and returns clear daemon errors", async () => {
    const { socket } = await startDaemon();
    const raw = await connectRaw(socket);
    raw.write(
      `{"version":${WORK_PROTOCOL_VERSION},"kind":"request","id":"a","action":"ping"}\n` +
        `{"version":${WORK_PROTOCOL_VERSION},"kind":"request","id":"b","action":"not-real"}\n`,
    );
    const messages = await readMessages(raw, 2);
    expect(messages[0]).toMatchObject({ id: "a", ok: true });
    expect(messages[1]).toEqual({
      version: WORK_PROTOCOL_VERSION,
      kind: "response",
      id: "b",
      ok: false,
      error: { code: "unknown-action", message: "Unknown protocol request action." },
    });
    raw.destroy();
  });

  test("bounds invalid frame errors and disconnects repeated invalid clients", async () => {
    const { socket } = await startDaemon();
    const raw = await connectRaw(socket);
    const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
    raw.write("not-json\nnot-json\nnot-json\n");
    const messages = await readMessages(raw, 3);
    expect(
      messages.every((message) => {
        const error = message["error"] as Record<string, unknown>;
        return error["code"] === "invalid-json";
      }),
    ).toBe(true);
    await closed;
  });

  test("serves a snapshot and delivers semantic events after subscription", async () => {
    const { daemon, socket } = await startDaemon();
    const client = await WorkClient.connect(socket);
    const snapshot = await client.snapshot();
    expect(snapshot.topics).toEqual([]);
    expect(snapshot.revision).toBe(0);
    expect(snapshot.daemon.protocolVersion).toBe(WORK_PROTOCOL_VERSION);
    const event = new Promise<string>((resolve) => {
      void client.subscribe((value) => resolve(value.type));
    });
    await Bun.sleep(10);
    daemon.publish({ type: "snapshot-changed" });
    expect(await event).toBe("snapshot-changed");
    expect((await client.snapshot()).revision).toBe(1);
    client.close();
  });

  test("pings end to end and cleans up clients and server shutdown", async () => {
    const { daemon, socket } = await startDaemon();
    const client = await WorkClient.connect(socket);
    expect((await client.ping()).protocolVersion).toBe(WORK_PROTOCOL_VERSION);
    expect(daemon.clientCount).toBe(1);
    client.close();
    await Bun.sleep(10);
    expect(daemon.clientCount).toBe(0);
    await daemon.stop();
    daemons.splice(daemons.indexOf(daemon), 1);
    await expect(WorkClient.connect(socket, { timeoutMs: 30 })).rejects.toThrow();
  });
});

async function connectRaw(path: string): Promise<Socket> {
  const socket = createConnection(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function readMessages(socket: Socket, count: number): Promise<Record<string, unknown>[]> {
  const decoder = new NdjsonDecoder();
  const messages: Record<string, unknown>[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out reading daemon messages.")), 1_000);
    socket.on("data", (chunk) => {
      for (const frame of decoder.feed(chunk)) {
        if (frame.ok) messages.push(JSON.parse(frame.text));
      }
      if (messages.length >= count) {
        clearTimeout(timer);
        resolve(messages);
      }
    });
  });
}
