import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  type AbsolutePath,
  type Branch,
  FullCommitSha,
  GitHubFailure,
  type Repository,
} from "../../domain/index.ts";
import { ProcessExecutor, type ProcessResult } from "../process/index.ts";

const PROCESS_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1_024;
const MAX_REVIEW_THREADS = 100;

const PR_FIELDS = `
  number
  url
  state
  headRefOid
  isDraft
  reviewDecision
  reviewRequests{totalCount}
  latestReviews:latestReviews(first:${MAX_REVIEW_THREADS}){nodes{state author{login}}}
  reviewThreads(first:${MAX_REVIEW_THREADS}){nodes{isResolved}}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}
`;
const DISCOVERY_PR_QUERY = `query($owner:String!,$repo:String!,$branch:String!){repository(owner:$owner,name:$repo){pullRequests(headRefName:$branch,states:[OPEN,MERGED,CLOSED],first:1,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}}}`;
const TRACKED_PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){${PR_FIELDS}}}}`;

const Review = Schema.Struct({
  state: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});
const PullRequestNode = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  url: Schema.String.check(
    Schema.isPattern(/^https:\/\/github\.com\/[^\s]+$/, { expected: "a GitHub pull request URL" }),
  ),
  state: Schema.Literals(["OPEN", "MERGED", "CLOSED"]),
  headRefOid: Schema.String.check(
    Schema.isPattern(/^[0-9a-f]{40}$/i, { expected: "a full Git commit SHA" }),
  ),
  isDraft: Schema.Boolean,
  reviewDecision: Schema.NullOr(Schema.String),
  reviewRequests: Schema.Struct({ totalCount: Schema.Number }),
  latestReviews: Schema.Struct({ nodes: Schema.Array(Review) }),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ isResolved: Schema.Boolean })),
  }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(Schema.Struct({ state: Schema.String })),
        }),
      }),
    ),
  }),
});
const GitHubPayload = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.Struct({
      pullRequest: Schema.optional(Schema.NullOr(PullRequestNode)),
      pullRequests: Schema.optional(Schema.Struct({ nodes: Schema.Array(PullRequestNode) })),
    }),
  }),
});

export type PullRequestState = "open" | "merged" | "closed";
export type PullRequestCi = "none" | "pending" | "passing" | "failing";
export interface PullRequestObservation {
  readonly number: number;
  readonly url: string;
  readonly state: PullRequestState;
  readonly draft: boolean;
  readonly ci: PullRequestCi;
  readonly reviewPending: boolean;
  readonly copilotReviewed: boolean;
  readonly changesRequested: boolean;
  readonly approved: boolean;
  readonly unresolvedThreads: number;
}

export interface PullRequestTarget {
  readonly repository: Repository;
  readonly branch: Branch;
  readonly worktreePath: AbsolutePath;
  readonly knownPullRequestNumber?: number;
}

type GitHubRequirements = ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;
type GitHubEffect<A> = Effect.Effect<A, GitHubFailure, GitHubRequirements>;

/** A gh-backed semantic observer. Authentication stays in the gh environment. */
export interface GitHubPullRequests {
  readonly observe: (target: PullRequestTarget) => GitHubEffect<PullRequestObservation | null>;
}

export const GitHubPullRequests = Context.Service<GitHubPullRequests>("Work/GitHubPullRequests");

export interface GitHubPullRequestsOptions {
  readonly ghExecutable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export function makeGitHubPullRequests(
  processes: ProcessExecutor,
  options: GitHubPullRequestsOptions = {},
): GitHubPullRequests {
  const run = (target: PullRequestTarget, executable: string, arguments_: readonly string[]) =>
    processes
      .run({
        command: { _tag: "Executable", executable, arguments: arguments_ },
        cwd: target.worktreePath,
        timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS,
        maxOutputBytes: options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError((cause) => unavailable("GitHub observation could not start.", cause)),
        Effect.flatMap(requireSuccessful),
      );

  return {
    observe: (target) => {
      const tracked = target.knownPullRequestNumber !== undefined;
      const [owner, repo] = target.repository.split("/", 2) as [string, string];
      const selector = tracked
        ? `number=${target.knownPullRequestNumber}`
        : `branch=${target.branch}`;
      return run(target, options.ghExecutable ?? "gh", [
        "api",
        "graphql",
        "-f",
        `query=${tracked ? TRACKED_PR_QUERY : DISCOVERY_PR_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `repo=${repo}`,
        "-F",
        selector,
      ]).pipe(
        Effect.flatMap(decodePayload),
        Effect.flatMap((node) => {
          if (node === null) return Effect.succeed(null);
          const observation = toObservation(node);
          if (tracked || observation.state === "open") return Effect.succeed(observation);
          return run(target, "git", ["rev-parse", "--verify", `refs/heads/${target.branch}`]).pipe(
            Effect.flatMap((result) =>
              Effect.try({
                try: () =>
                  Schema.decodeUnknownSync(FullCommitSha)(result.stdout.trim().toLowerCase()),
                catch: (cause) => invalidResponse("Git returned an invalid Branch tip.", cause),
              }),
            ),
            Effect.map((branchTip) =>
              branchTip === node.headRefOid.toLowerCase() ? observation : null,
            ),
          );
        }),
      );
    },
  };
}

export const GitHubPullRequestsLive = Layer.effect(
  GitHubPullRequests,
  Effect.gen(function* () {
    return makeGitHubPullRequests(yield* ProcessExecutor);
  }),
);

function requireSuccessful(result: ProcessResult): Effect.Effect<ProcessResult, GitHubFailure> {
  if (result.status !== "completed" || result.exitCode !== 0) {
    return Effect.fail(unavailable("GitHub observation is unavailable.", result));
  }
  if (result.outputTruncated) {
    return Effect.fail(unavailable("GitHub output exceeded its safe limit.", result));
  }
  return Effect.succeed(result);
}

function decodePayload(
  result: ProcessResult,
): Effect.Effect<typeof PullRequestNode.Type | null, GitHubFailure> {
  return Effect.try({
    try: () => JSON.parse(result.stdout) as unknown,
    catch: (cause) => invalidResponse("GitHub returned invalid JSON.", cause),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(GitHubPayload, { errors: "first" })(value).pipe(
        Effect.mapError((cause) => invalidResponse("GitHub returned an invalid response.", cause)),
      ),
    ),
    Effect.map(
      ({ data }) => data.repository.pullRequest ?? data.repository.pullRequests?.nodes[0] ?? null,
    ),
  );
}

function toObservation(node: typeof PullRequestNode.Type): PullRequestObservation {
  const state = node.state === "OPEN" ? "open" : node.state === "MERGED" ? "merged" : "closed";
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state;
  const ci: PullRequestCi =
    rollup === "FAILURE" || rollup === "ERROR"
      ? "failing"
      : rollup === "PENDING" || rollup === "EXPECTED"
        ? "pending"
        : rollup === "SUCCESS"
          ? "passing"
          : "none";
  return {
    number: node.number,
    url: node.url,
    state,
    draft: node.isDraft,
    ci,
    reviewPending: node.reviewRequests.totalCount > 0,
    copilotReviewed: node.latestReviews.nodes.some(
      (review) =>
        review.state !== "PENDING" &&
        review.author?.login.toLowerCase().includes("copilot") === true,
    ),
    changesRequested: node.reviewDecision === "CHANGES_REQUESTED",
    approved: node.reviewDecision === "APPROVED",
    unresolvedThreads: node.reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
  };
}

function unavailable(message: string, internalCause: unknown): GitHubFailure {
  return new GitHubFailure({ reason: "unavailable", message, internalCause });
}

function invalidResponse(message: string, internalCause: unknown): GitHubFailure {
  return new GitHubFailure({ reason: "invalid-response", message, internalCause });
}
