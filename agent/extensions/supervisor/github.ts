import type { ExecFn, GitHubNotificationItem } from "./types";

const LIST_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 10_000;
const NOTIFICATION_LIMIT = 100;

interface GhNotificationResponse {
	id?: unknown;
	reason?: unknown;
	updated_at?: unknown;
	repository?: { full_name?: unknown };
	subject?: {
		title?: unknown;
		type?: unknown;
		url?: unknown;
		latest_comment_url?: unknown;
	};
}

export class GitHubClient {
	constructor(private readonly exec: ExecFn) {}

	async listNotifications(): Promise<GitHubNotificationItem[]> {
		const result = await this.exec("gh", ["api", `notifications?per_page=${NOTIFICATION_LIMIT}`], {
			timeout: LIST_TIMEOUT_MS,
		});
		assertOk(result, "gh api notifications failed");

		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout || "[]");
		} catch (error) {
			throw new Error(`failed to parse gh notifications JSON: ${error instanceof Error ? error.message : String(error)}`);
		}

		if (!Array.isArray(parsed)) {
			throw new Error("gh notifications response was not an array");
		}

		const items = parsed.map(normalizeNotification).filter((item): item is GitHubNotificationItem => item !== undefined);
		await this.hydratePullRequestInfo(items);
		return items;
	}

	private async hydratePullRequestInfo(items: GitHubNotificationItem[]): Promise<void> {
		const pullRequests = items.map((item, index) => ({ item, index, ref: parsePullRequestApiUrl(item.subject.url) })).filter(
			(entry): entry is { item: GitHubNotificationItem; index: number; ref: PullRequestRef } => entry.ref !== undefined,
		);
		if (pullRequests.length === 0) return;

		const fields = pullRequests
			.map(
				({ index, ref }) =>
					`n${index}: repository(owner: ${JSON.stringify(ref.owner)}, name: ${JSON.stringify(ref.repo)}) { pullRequest(number: ${ref.number}) { author { login } state merged isDraft reviewDecision } }`,
			)
			.join("\n");

		const result = await this.exec("gh", ["api", "graphql", "-f", `query=query {\n${fields}\n}`], {
			timeout: ACTION_TIMEOUT_MS,
		});
		if (result.code !== 0 || result.killed) return;

		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdout || "{}");
		} catch {
			return;
		}

		const data = (
			parsed as {
				data?: Record<
					string,
					{
						pullRequest?: {
							author?: { login?: unknown } | null;
							state?: unknown;
							merged?: unknown;
							isDraft?: unknown;
							reviewDecision?: unknown;
						} | null;
					} | null
				>;
			}
		).data;
		if (!data) return;

		for (const { item, index } of pullRequests) {
			const pullRequest = data[`n${index}`]?.pullRequest;
			if (!pullRequest) continue;

			const login = pullRequest.author?.login;
			if (typeof login === "string" && login.length > 0) item.author = login;

			item.pullRequest = {
				state: typeof pullRequest.state === "string" ? pullRequest.state : undefined,
				merged: typeof pullRequest.merged === "boolean" ? pullRequest.merged : undefined,
				isDraft: typeof pullRequest.isDraft === "boolean" ? pullRequest.isDraft : undefined,
				reviewDecision: asNullableString(pullRequest.reviewDecision),
			};
		}
	}

	async markRead(threadId: string): Promise<void> {
		const result = await this.exec("gh", ["api", "-X", "PATCH", `notifications/threads/${threadId}`], {
			timeout: ACTION_TIMEOUT_MS,
		});
		assertOk(result, "mark-read failed");
	}

	async resolveHtmlUrl(item: GitHubNotificationItem): Promise<string> {
		if (item.htmlUrl) return item.htmlUrl;

		const result = await this.exec("gh", ["api", item.subject.url, "--jq", ".html_url"], {
			timeout: ACTION_TIMEOUT_MS,
		});
		assertOk(result, "resolve url failed");

		const htmlUrl = result.stdout.trim();
		if (!htmlUrl || htmlUrl === "null") {
			throw new Error(`no html_url for ${item.subject.type}`);
		}

		item.htmlUrl = htmlUrl;
		return htmlUrl;
	}
}

function normalizeNotification(raw: GhNotificationResponse): GitHubNotificationItem | undefined {
	const id = asString(raw.id);
	const reason = asString(raw.reason);
	const updatedAt = asString(raw.updated_at);
	const repository = asString(raw.repository?.full_name);
	const title = asString(raw.subject?.title);
	const type = asString(raw.subject?.type);
	const url = asString(raw.subject?.url);

	if (!id || !reason || !updatedAt || !repository || !title || !type || !url) return undefined;

	return {
		id,
		reason,
		updatedAt,
		repository,
		subject: {
			title,
			type,
			url,
			latestCommentUrl: asNullableString(raw.subject?.latest_comment_url),
		},
	};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null | undefined {
	if (value === null) return null;
	return asString(value);
}

interface PullRequestRef {
	owner: string;
	repo: string;
	number: number;
}

function parsePullRequestApiUrl(url: string): PullRequestRef | undefined {
	const match = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/);
	if (!match) return undefined;
	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function assertOk(result: { code: number; stdout: string; stderr: string; killed?: boolean }, message: string): void {
	if (result.code === 0 && !result.killed) return;

	const details = (result.stderr || result.stdout || (result.killed ? "command timed out" : "unknown error")).trim();
	throw new Error(details ? `${message}: ${details}` : message);
}
