import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { PrivateLocalCapability, TopicId, decodeAbsolutePath } from "../../domain/index.ts";
import {
  ProcessPlatformLive,
  type ProcessExecutor,
  type ProcessRequest,
  type ProcessResult,
} from "../process/index.ts";
import {
  type I3Node,
  mainAgentMark,
  mainAgentShellInvocation,
  mainAgentWindowIdentity,
  makeDesktopControl,
  planWorkspaceRearrangement,
  selectTopicWorkspace,
  topicMark,
} from "./desktop-control.ts";

const roots: string[] = [];
const completed = (stdout = ""): ProcessResult => ({
  status: "completed",
  exitCode: 0,
  stdout,
  stderr: "",
  outputTruncated: false,
});

class FakeProcesses implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];
  readonly trees: unknown[] = [];
  run = (request: ProcessRequest) => {
    this.requests.push(request);
    const command = request.command;
    if (
      command._tag === "Executable" &&
      command.executable === "i3-msg" &&
      command.arguments?.[0] === "-t"
    ) {
      return Effect.succeed(completed(JSON.stringify(this.trees.shift())));
    }
    return Effect.succeed(completed("[]"));
  };
}

const root = (...nodes: I3Node[]): I3Node => ({ type: "root", nodes, floating_nodes: [] });
const workspace = (num: number, nodes: I3Node[] = []): I3Node => ({
  id: 100 + num,
  type: "workspace",
  num,
  nodes,
  floating_nodes: [],
});
const windowNode = (id: number, mark: string): I3Node => ({
  id,
  type: "con",
  window: 1_000 + id,
  marks: [mark],
  nodes: [],
  floating_nodes: [],
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Effect desktop adapter", () => {
  test("keeps Main Agent marks authoritative for workspace selection", () => {
    const topic = "11111111-1111-4111-8111-111111111111";
    expect(
      selectTopicWorkspace(
        root(
          workspace(2, [windowNode(2, "other")]),
          workspace(5, [windowNode(5, mainAgentMark(topic))]),
        ),
        topic,
      ),
    ).toEqual({ kind: "selected", workspace: 5 });
  });

  test("moves only Work-managed windows into earlier workspace gaps", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(
      planWorkspaceRearrangement(
        root(
          workspace(1, [windowNode(1, "browser")]),
          workspace(2, [windowNode(2, "work-dashboard")]),
          workspace(4, [windowNode(4, topicMark(first)), windowNode(14, mainAgentMark(first))]),
          workspace(6, [windowNode(6, topicMark(second))]),
          workspace(9, [windowNode(9, "slack")]),
        ),
      ),
    ).toEqual([
      { from: 4, to: 3, conIds: [4, 14] },
      { from: 6, to: 4, conIds: [6] },
    ]);
  });

  test("distinguishes one Main Agent window from absent and ambiguous windows", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-work-desktop-presence-"));
    roots.push(temporary);
    const topicId = Schema.decodeUnknownSync(TopicId)("11111111-1111-4111-8111-111111111111");
    const mark = mainAgentMark(topicId);
    const processes = new FakeProcesses();
    processes.trees.push(
      root(workspace(1)),
      root(workspace(1, [windowNode(1, mark)])),
      root(workspace(1, [windowNode(1, mark), windowNode(2, mark)])),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const desktop = makeDesktopControl(processes, fs, {
            processCwd: decodeAbsolutePath(temporary),
            runtimeDirectory: decodeAbsolutePath(temporary),
          });
          const absent = yield* desktop.hasMainAgentWindow(topicId);
          const present = yield* desktop.hasMainAgentWindow(topicId);
          const ambiguous = yield* Effect.flip(desktop.hasMainAgentWindow(topicId));
          return { absent, present, ambiguous };
        }),
      ).pipe(Effect.provide([BunFileSystem.layer, ProcessPlatformLive])),
    );

    expect(result.absent).toBeFalse();
    expect(result.present).toBeTrue();
    expect(result.ambiguous.reason).toBe("ambiguous");
  });

  test("uses a private zsh startup file and keeps capabilities only in the child environment", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-work-desktop-effect-"));
    roots.push(temporary);
    const runtime = decodeAbsolutePath(join(temporary, "runtime"));
    const worktree = decodeAbsolutePath(join(temporary, "worktree"));
    const topicId = Schema.decodeUnknownSync(TopicId)("11111111-1111-4111-8111-111111111111");
    const identity = mainAgentWindowIdentity(topicId);
    const processes = new FakeProcesses();
    processes.trees.push(
      root(workspace(1)),
      root(
        workspace(1, [
          {
            id: 30,
            type: "con",
            window: 1_030,
            marks: [],
            window_properties: { class: identity, instance: identity },
            nodes: [],
            floating_nodes: [],
          },
        ]),
      ),
    );
    const token = Schema.decodeUnknownSync(PrivateLocalCapability)("registration-secret");
    const affiliation = Schema.decodeUnknownSync(PrivateLocalCapability)("affiliation-secret");

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* makeDesktopControl(processes, fs, {
            processCwd: decodeAbsolutePath(temporary),
            runtimeDirectory: runtime,
            shellExecutable: "/usr/bin/zsh",
            piExecutable: "/test/bin/pi",
          }).openMainAgent({
            topicId,
            topicName: "Topic",
            worktreePath: worktree,
            sessionId: "session",
            socketPath: decodeAbsolutePath(join(temporary, "work.sock")),
            registrationToken: token,
            affiliationToken: affiliation,
          });
        }),
      ).pipe(Effect.provide([BunFileSystem.layer, ProcessPlatformLive])),
    );

    expect(result).toMatchObject({ kind: "launched", workspace: 1 });
    const kitty = processes.requests.find(
      (request) => request.command._tag === "Executable" && request.command.executable === "kitty",
    )!;
    expect(kitty.environment).toMatchObject({
      PI_WORK_REGISTRATION_TOKEN: "registration-secret",
      PI_WORK_AFFILIATION: "affiliation-secret",
    });
    expect(JSON.stringify(kitty.command)).not.toContain("registration-secret");
    const invocation = mainAgentShellInvocation({
      shellPath: "/usr/bin/zsh",
      runtimeDir: runtime,
      topicId,
      nodeCommand: undefined,
      piCommand: "/test/bin/pi",
      sessionId: "session",
      topicName: "Topic",
    });
    expect((await stat(invocation.rcFile!.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(invocation.rcFile!.path))).mode & 0o777).toBe(0o700);
  });
});
