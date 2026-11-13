import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

export type NotificationSubjectType =
  | "PullRequest"
  | "Issue"
  | "Release"
  | "Discussion"
  | "Commit"
  | "CheckSuite"
  | "RepositoryDependabotAlertsThread"
  | string;

export interface GitHubNotificationSubject {
  title: string;
  type: NotificationSubjectType;
  url: string;
  latestCommentUrl?: string | null | undefined;
}

export interface PullRequestInfo {
  state?: string | undefined;
  merged?: boolean | undefined;
  isDraft?: boolean | undefined;
  reviewDecision?: string | null | undefined;
}

export interface GitHubNotificationItem {
  id: string;
  reason: string;
  updatedAt: string;
  unread: boolean;
  repository: string;
  author?: string | undefined;
  pullRequest?: PullRequestInfo | undefined;
  subject: GitHubNotificationSubject;
  htmlUrl?: string | undefined;
}

export type { ExecResult };

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;
