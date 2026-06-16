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
	latestCommentUrl?: string | null;
}

export interface PullRequestInfo {
	state?: string;
	merged?: boolean;
	isDraft?: boolean;
	reviewDecision?: string | null;
}

export interface GitHubNotificationItem {
	id: string;
	reason: string;
	updatedAt: string;
	repository: string;
	author?: string;
	pullRequest?: PullRequestInfo;
	subject: GitHubNotificationSubject;
	htmlUrl?: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
}

export type ExecFn = (
	command: string,
	args: string[],
	options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;
