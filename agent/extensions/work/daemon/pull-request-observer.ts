import type { PullRequestCi, PullRequestRef, PullRequestState } from "../shared/domain.ts";
import { LocalProcessRunner } from "./process-runner.ts";
import type { ProcessRunner } from "./process-runner.ts";

const PROCESS_TIMEOUT_MS = 15_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_REVIEW_THREADS = 100;

const PR_FIELDS = `
  number
  url
  state
  isDraft
  reviewDecision
  reviewRequests{totalCount}
  latestReviews:latestReviews(first:${MAX_REVIEW_THREADS}){nodes{state author{login}}}
  reviewThreads(first:${MAX_REVIEW_THREADS}){nodes{isResolved}}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}
`;

/** Finds only an open PR when this Topic does not have a tracked PR identity yet. */
const OPEN_PR_QUERY = `query($owner:String!,$repo:String!,$branch:String!){
  repository(owner:$owner,name:$repo){
    pullRequests(headRefName:$branch,states:[OPEN],first:1,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{${PR_FIELDS}}
    }
  }
}`;

/** Refreshes one already tracked PR by stable number, including its terminal lifecycle state. */
const TRACKED_PR_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){${PR_FIELDS}}
  }
}`;

export interface PullRequestObserverOptions {
  runner?: ProcessRunner;
  ghCommand?: string;
  processTimeoutMs?: number;
  maxProcessOutputBytes?: number;
}

export interface PullRequestTarget {
  owner: string;
  repo: string;
  branch: string;
  worktreePath: string;
  /** Stable identity from a prior open-PR discovery. */
  knownPullRequestNumber?: number;
}

/** Discovers the pull request for one Topic branch without owning Topic state. */
export class PullRequestObserver {
  private readonly runner: ProcessRunner;
  private readonly ghCommand: string;
  private readonly processTimeoutMs: number;
  private readonly maxProcessOutputBytes: number;

  constructor(options: PullRequestObserverOptions = {}) {
    this.runner = options.runner ?? new LocalProcessRunner();
    this.ghCommand = options.ghCommand ?? "gh";
    this.processTimeoutMs = options.processTimeoutMs ?? PROCESS_TIMEOUT_MS;
    this.maxProcessOutputBytes = options.maxProcessOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  }

  /** Finds an open PR for a new Topic, or refreshes its previously tracked PR by number. */
  async discover(target: PullRequestTarget, signal?: AbortSignal): Promise<PullRequestRef | null> {
    const tracked = target.knownPullRequestNumber !== undefined;
    const query = tracked ? TRACKED_PR_QUERY : OPEN_PR_QUERY;
    const selector = tracked
      ? `number=${target.knownPullRequestNumber}`
      : `branch=${target.branch}`;
    let result;
    try {
      result = await this.runner.run({
        command: this.ghCommand,
        args: [
          "api",
          "graphql",
          "-f",
          `query=${query}`,
          "-f",
          `owner=${target.owner}`,
          "-f",
          `repo=${target.repo}`,
          "-F",
          selector,
        ],
        cwd: target.worktreePath,
        timeoutMs: this.processTimeoutMs,
        maxOutputBytes: this.maxProcessOutputBytes,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      return null;
    }
    if (result.status !== "completed" || result.exitCode !== 0 || result.outputTruncated) {
      return null;
    }
    const pullRequest = parsePullRequest(result.stdout);
    // A closed PR found by branch text is stale. Terminal states belong only to a PR
    // that this Topic first observed while it was open and now tracks by number.
    return tracked || pullRequest?.state === "open" ? pullRequest : null;
  }
}

export function parsePullRequest(stdout: string): PullRequestRef | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const node = pullRequestNode(value);
  if (node === null) return null;

  const number = node["number"];
  const url = node["url"];
  if (
    typeof number !== "number" ||
    !Number.isInteger(number) ||
    number <= 0 ||
    typeof url !== "string" ||
    !/^https:\/\/github\.com\/[^\s]+$/.test(url)
  ) {
    return null;
  }
  const state = parseState(node["state"]);
  if (state === null) return null;

  const decision = node["reviewDecision"];
  return {
    number,
    url,
    state,
    draft: node["isDraft"] === true,
    ci: parseCi(node["commits"]),
    reviewPending: reviewRequestCount(node["reviewRequests"]) > 0,
    copilotReviewed: hasCopilotReview(node["latestReviews"]),
    changesRequested: decision === "CHANGES_REQUESTED",
    approved: decision === "APPROVED",
    unresolvedThreads: unresolvedThreadCount(node["reviewThreads"]),
  };
}

function pullRequestNode(value: unknown): Record<string, unknown> | null {
  const repository = record(record(record(value)?.["data"])?.["repository"]);
  const tracked = record(repository?.["pullRequest"]);
  if (tracked !== undefined) return tracked;
  const nodes = record(repository?.["pullRequests"])?.["nodes"];
  if (!Array.isArray(nodes)) return null;
  return record(nodes[0]) ?? null;
}

function parseState(input: unknown): PullRequestState | null {
  switch (input) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    default:
      return null;
  }
}

function parseCi(commits: unknown): PullRequestCi {
  const nodes = record(commits)?.["nodes"];
  const rollup = Array.isArray(nodes)
    ? record(record(record(nodes[0])?.["commit"])?.["statusCheckRollup"])
    : undefined;
  switch (rollup?.["state"]) {
    case "FAILURE":
    case "ERROR":
      return "failing";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    case "SUCCESS":
      return "passing";
    default:
      return "none";
  }
}

function reviewRequestCount(reviewRequests: unknown): number {
  const total = record(reviewRequests)?.["totalCount"];
  return typeof total === "number" && total > 0 ? total : 0;
}

/** True when the Copilot reviewer has submitted a (non-pending) review of the head. */
function hasCopilotReview(latestReviews: unknown): boolean {
  const nodes = record(latestReviews)?.["nodes"];
  if (!Array.isArray(nodes)) return false;
  return nodes.some((review) => {
    const node = record(review);
    if (node === undefined || node["state"] === "PENDING") return false;
    const login = record(node["author"])?.["login"];
    return typeof login === "string" && login.toLowerCase().includes("copilot");
  });
}

function unresolvedThreadCount(reviewThreads: unknown): number {
  const nodes = record(reviewThreads)?.["nodes"];
  if (!Array.isArray(nodes)) return 0;
  return nodes.filter((thread) => record(thread)?.["isResolved"] === false).length;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
