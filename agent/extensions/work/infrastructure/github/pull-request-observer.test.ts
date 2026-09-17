import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { decodeAbsolutePath, decodeBranch, decodeRepository } from "../../domain/index.ts";
import {
  ProcessPlatformLive,
  type ProcessExecutor,
  type ProcessRequest,
  type ProcessResult,
} from "../process/index.ts";
import { makeGitHubPullRequests } from "./pull-request-observer.ts";

const completed = (stdout: string): ProcessResult => ({
  status: "completed",
  exitCode: 0,
  stdout,
  stderr: "",
  outputTruncated: false,
});

class FakeProcesses implements ProcessExecutor {
  readonly requests: ProcessRequest[] = [];
  private readonly results: ProcessResult[];

  constructor(results: ProcessResult[]) {
    this.results = results;
  }

  run = (request: ProcessRequest) => {
    this.requests.push(request);
    return Effect.succeed(this.results.shift()!);
  };
}

function run<A>(effect: Effect.Effect<A, unknown, any>): Promise<A> {
  const runnable = Effect.scoped(effect).pipe(Effect.provide(ProcessPlatformLive)) as Effect.Effect<
    A,
    unknown,
    never
  >;
  return Effect.runPromise(runnable);
}

function payload(state = "OPEN") {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 7,
              url: "https://github.com/owner/repo/pull/7",
              state,
              headRefOid: "a".repeat(40),
              isDraft: false,
              reviewDecision: "CHANGES_REQUESTED",
              reviewRequests: { totalCount: 1 },
              latestReviews: {
                nodes: [{ state: "COMMENTED", author: { login: "copilot-pull-request-reviewer" } }],
              },
              reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }] },
              commits: {
                nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }],
              },
            },
          ],
        },
      },
    },
  });
}

const target = {
  repository: decodeRepository("owner/repo"),
  branch: decodeBranch("feat-x"),
  worktreePath: decodeAbsolutePath("/tmp/worktree"),
};

describe("Effect GitHub pull request adapter", () => {
  test("keeps the bounded gh GraphQL contract and decodes lifecycle signals", async () => {
    const processes = new FakeProcesses([completed(payload())]);
    const result = await run(makeGitHubPullRequests(processes).observe(target));

    expect(result).toEqual({
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "open",
      draft: false,
      ci: "passing",
      reviewPending: true,
      copilotReviewed: true,
      changesRequested: true,
      approved: false,
      unresolvedThreads: 1,
    });
    expect(processes.requests[0]).toMatchObject({
      cwd: "/tmp/worktree",
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1_024,
      command: { _tag: "Executable", executable: "gh" },
    });
    const command = processes.requests[0]!.command;
    expect(command._tag).toBe("Executable");
    if (command._tag === "Executable") {
      const arguments_ = command.arguments ?? [];
      expect(arguments_).toContain("owner=owner");
      expect(arguments_).toContain("repo=repo");
      expect(arguments_).toContain("branch=feat-x");
      const query = arguments_.find((argument) => argument.startsWith("query="));
      expect(query).toContain("states:[OPEN,MERGED]");
      expect(query).not.toContain("CLOSED");
    }
  });

  test("recovers a terminal identity only when the local Branch tip is equal", async () => {
    const processes = new FakeProcesses([
      completed(payload("MERGED")),
      completed(`${"a".repeat(40)}\n`),
    ]);
    const result = await run(makeGitHubPullRequests(processes).observe(target));

    expect(result).toMatchObject({ number: 7, state: "merged" });
    expect(processes.requests[1]?.command).toEqual({
      _tag: "Executable",
      executable: "git",
      arguments: ["rev-parse", "--verify", "refs/heads/feat-x"],
    });
  });

  test("returns a typed failure so the worker can retry malformed output", async () => {
    const malformed = new FakeProcesses([completed("not-json")]);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(makeGitHubPullRequests(malformed).observe(target)).pipe(
        Effect.provide(ProcessPlatformLive),
      ),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("GitHub returned invalid JSON");
  });
});
