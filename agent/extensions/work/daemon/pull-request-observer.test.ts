import { describe, expect, test } from "bun:test";
import { PullRequestObserver, parsePullRequest } from "./pull-request-observer.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";

class StubRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];
  private readonly result: ProcessResult | (() => Promise<ProcessResult>);
  constructor(result: ProcessResult | (() => Promise<ProcessResult>)) {
    this.result = result;
  }
  run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    return typeof this.result === "function" ? this.result() : Promise.resolve(this.result);
  }
}

function completed(stdout: string, exitCode = 0): ProcessResult {
  return {
    status: "completed",
    exitCode,
    stdout,
    stderr: "",
    outputTruncated: false,
  };
}

interface NodeOverrides {
  number?: number;
  url?: string;
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  reviewRequests?: number;
  reviewThreads?: boolean[];
  ci?: string | null;
}

function payload(node: NodeOverrides): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequests: {
          nodes: [
            {
              number: node.number ?? 7,
              url: node.url ?? "https://github.com/owner/repo/pull/7",
              state: node.state ?? "OPEN",
              isDraft: node.isDraft ?? false,
              reviewDecision: node.reviewDecision ?? null,
              reviewRequests: { totalCount: node.reviewRequests ?? 0 },
              reviewThreads: {
                nodes: (node.reviewThreads ?? []).map((isResolved) => ({ isResolved })),
              },
              commits: {
                nodes: [
                  { commit: { statusCheckRollup: node.ci == null ? null : { state: node.ci } } },
                ],
              },
            },
          ],
        },
      },
    },
  });
}

describe("pull request parsing", () => {
  test("reads a well-formed graphql payload into signal fields", () => {
    expect(
      parsePullRequest(
        payload({
          reviewDecision: "CHANGES_REQUESTED",
          reviewThreads: [false, true],
          ci: "SUCCESS",
        }),
      ),
    ).toEqual({
      number: 7,
      url: "https://github.com/owner/repo/pull/7",
      state: "open",
      draft: false,
      ci: "passing",
      reviewPending: false,
      changesRequested: true,
      approved: false,
      unresolvedThreads: 1,
    });
  });

  test("maps lifecycle, CI, and pending-review signals", () => {
    expect(parsePullRequest(payload({ state: "MERGED" }))).toMatchObject({ state: "merged" });
    expect(parsePullRequest(payload({ ci: "FAILURE" }))).toMatchObject({ ci: "failing" });
    expect(parsePullRequest(payload({ ci: "ERROR" }))).toMatchObject({ ci: "failing" });
    expect(parsePullRequest(payload({ ci: "PENDING" }))).toMatchObject({ ci: "pending" });
    expect(parsePullRequest(payload({ ci: null }))).toMatchObject({ ci: "none" });
    expect(parsePullRequest(payload({ reviewRequests: 1 }))).toMatchObject({ reviewPending: true });
    expect(parsePullRequest(payload({ reviewDecision: "APPROVED" }))).toMatchObject({
      approved: true,
    });
  });

  test("rejects invalid, non-integer, non-github, unknown-state, or empty payloads", () => {
    expect(parsePullRequest("not json")).toBeNull();
    expect(parsePullRequest("[]")).toBeNull();
    expect(parsePullRequest('{"data":{"repository":{"pullRequests":{"nodes":[]}}}}')).toBeNull();
    expect(parsePullRequest(payload({ number: 0 }))).toBeNull();
    expect(parsePullRequest(payload({ number: 1.5 }))).toBeNull();
    expect(parsePullRequest(payload({ url: "https://evil.example/1" }))).toBeNull();
    expect(parsePullRequest(payload({ state: "WEIRD" }))).toBeNull();
  });
});

describe("pull request observer", () => {
  test("queries the graphql api in the worktree and returns the reference", async () => {
    const runner = new StubRunner(completed(payload({ number: 7, ci: "SUCCESS" })));
    const observer = new PullRequestObserver({ runner });
    const result = await observer.discover({
      owner: "owner",
      repo: "repo",
      branch: "feat-x",
      worktreePath: "/wt/x",
    });
    expect(result).toMatchObject({ number: 7, ci: "passing" });
    const call = runner.calls[0];
    expect(call).toMatchObject({ command: "gh", cwd: "/wt/x" });
    expect(call?.args?.[0]).toBe("api");
    expect(call?.args?.[1]).toBe("graphql");
    expect(call?.args).toContain("owner=owner");
    expect(call?.args).toContain("repo=repo");
    expect(call?.args).toContain("branch=feat-x");
  });

  test("returns null when gh exits non-zero or the process fails", async () => {
    const missing = new PullRequestObserver({
      runner: new StubRunner(completed("", 1)),
    });
    expect(
      await missing.discover({ owner: "o", repo: "r", branch: "feat-x", worktreePath: "/wt/x" }),
    ).toBeNull();

    const throwing = new PullRequestObserver({
      runner: new StubRunner(() => Promise.reject(new Error("spawn failed"))),
    });
    expect(
      await throwing.discover({ owner: "o", repo: "r", branch: "feat-x", worktreePath: "/wt/x" }),
    ).toBeNull();
  });
});
