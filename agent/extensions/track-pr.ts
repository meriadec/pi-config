import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

const POLL_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const STATUS_KEY = "track-pr";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;

type PullRequestRef = {
	owner: string;
	repo: string;
	number: number;
	url: string;
};

type CopilotStatus = {
	finished: boolean;
	hasCopilotActivity: boolean;
	hasPendingCopilotRequest: boolean;
	activitySummary: string;
};

type TrackJob = {
	cancelled: boolean;
	pollTimer?: NodeJS.Timeout | undefined;
	spinnerTimer?: NodeJS.Timeout | undefined;
	spinnerFrame: number;
	statusText: string;
	wake?: (() => void) | undefined;
};

let activeJob: TrackJob | undefined;

function execGh(args: string[], cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("gh", args, { cwd, timeout: 30_000 }, (error, stdout, stderr) => {
			if (error) {
				const message = stderr.trim() || error.message;
				reject(new Error(message));
				return;
			}

			resolve(stdout.trim());
		});
	});
}

function sleep(ms: number, job: TrackJob): Promise<void> {
	return new Promise((resolve) => {
		job.wake = resolve;
		job.pollTimer = setTimeout(() => {
			job.pollTimer = undefined;
			job.wake = undefined;
			resolve();
		}, ms);
	});
}

function parsePrUrl(text: string): PullRequestRef | undefined {
	const match = text.match(/https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/pull\/(\d+)/i);
	if (!match) return undefined;

	const [, owner, repo, number] = match;
	if (!owner || !repo || !number) return undefined;
	return {
		owner,
		repo,
		number: Number(number),
		url: `https://github.com/${owner}/${repo}/pull/${number}`,
	};
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
				return String(part.text);
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function findRecentPrInSession(ctx: ExtensionCommandContext): PullRequestRef | undefined {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i] as unknown;
		if (!entry || typeof entry !== "object" || !("type" in entry) || entry.type !== "message") continue;
		if (!("message" in entry)) continue;

		const message = entry.message as { content?: unknown };
		const pr = parsePrUrl(textFromContent(message.content));
		if (pr) return pr;
	}

	return undefined;
}

async function resolvePrFromGh(args: string, cwd: string): Promise<PullRequestRef | undefined> {
	const trimmed = args.trim();
	const explicitUrl = parsePrUrl(trimmed);
	if (explicitUrl) return explicitUrl;

	const ghArgs = ["pr", "view", "--json", "url"];
	if (/^#?\d+$/.test(trimmed)) {
		ghArgs.splice(2, 0, trimmed.replace(/^#/, ""));
	} else if (trimmed) {
		ghArgs.splice(2, 0, trimmed);
	}

	try {
		const output = await execGh(ghArgs, cwd);
		const data = JSON.parse(output) as { url?: string };
		return data.url ? parsePrUrl(data.url) : undefined;
	} catch {
		return undefined;
	}
}

function loginOfReviewer(reviewer: unknown): string {
	if (!reviewer || typeof reviewer !== "object") return "";
	if ("login" in reviewer && typeof reviewer.login === "string") return reviewer.login;
	if ("slug" in reviewer && typeof reviewer.slug === "string") return reviewer.slug;
	return "";
}

function isCopilotLogin(login: string | undefined): boolean {
	return Boolean(login && /copilot/i.test(login));
}

function collectCopilotEvents(node: unknown, events: Array<{ kind: string; login: string; when?: string }>, kind: string) {
	if (!node || typeof node !== "object") return;

	const author = "author" in node ? (node.author as { login?: string } | null) : undefined;
	const login = author?.login;
	if (!isCopilotLogin(login)) return;

	const when = "submittedAt" in node && typeof node.submittedAt === "string"
		? node.submittedAt
		: "createdAt" in node && typeof node.createdAt === "string"
			? node.createdAt
			: undefined;

	events.push({
		kind,
		login: login ?? "copilot",
		...(when === undefined ? {} : { when }),
	});
}

async function getCopilotStatus(pr: PullRequestRef, cwd: string): Promise<CopilotStatus> {
	const query = `
		query($owner: String!, $repo: String!, $number: Int!) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) {
					reviewRequests(first: 100) {
						nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { slug } } }
					}
					latestReviews(first: 100) {
						nodes { author { login } state submittedAt url }
					}
					comments(first: 100) {
						nodes { author { login } createdAt url }
					}
					reviewThreads(first: 100) {
						nodes { comments(first: 50) { nodes { author { login } createdAt url } } }
					}
				}
			}
		}`;

	const output = await execGh([
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-f",
		`owner=${pr.owner}`,
		"-f",
		`repo=${pr.repo}`,
		"-F",
		`number=${pr.number}`,
	], cwd);

	const data = JSON.parse(output) as {
		data?: {
			repository?: {
				pullRequest?: {
					reviewRequests?: { nodes?: Array<{ requestedReviewer?: unknown }> };
					latestReviews?: { nodes?: unknown[] };
					comments?: { nodes?: unknown[] };
					reviewThreads?: { nodes?: Array<{ comments?: { nodes?: unknown[] } }> };
				};
			};
		};
	};

	const pullRequest = data.data?.repository?.pullRequest;
	if (!pullRequest) throw new Error(`Could not fetch ${pr.url}`);

	const hasPendingCopilotRequest = Boolean(
		pullRequest.reviewRequests?.nodes?.some((node) => isCopilotLogin(loginOfReviewer(node.requestedReviewer))),
	);

	const events: Array<{ kind: string; login: string; when?: string }> = [];
	for (const review of pullRequest.latestReviews?.nodes ?? []) collectCopilotEvents(review, events, "review");
	for (const comment of pullRequest.comments?.nodes ?? []) collectCopilotEvents(comment, events, "comment");
	for (const thread of pullRequest.reviewThreads?.nodes ?? []) {
		for (const comment of thread.comments?.nodes ?? []) collectCopilotEvents(comment, events, "review-thread comment");
	}

	events.sort((a, b) => (a.when ?? "").localeCompare(b.when ?? ""));
	const lastEvent = events.at(-1);
	const hasCopilotActivity = events.length > 0;

	return {
		finished: hasCopilotActivity && !hasPendingCopilotRequest,
		hasCopilotActivity,
		hasPendingCopilotRequest,
		activitySummary: lastEvent
			? `${lastEvent.kind} by ${lastEvent.login}${lastEvent.when ? ` at ${lastEvent.when}` : ""}`
			: "no Copilot activity found yet",
	};
}

function renderSpinnerStatus(job: TrackJob) {
	const frame = SPINNER_FRAMES[job.spinnerFrame % SPINNER_FRAMES.length];
	job.spinnerFrame += 1;
	return `${frame} ${job.statusText}`;
}

function updateSpinnerStatus(ctx: ExtensionCommandContext, job: TrackJob, statusText?: string) {
	if (statusText) job.statusText = statusText;
	ctx.ui.setStatus(STATUS_KEY, renderSpinnerStatus(job));
}

function startSpinner(ctx: ExtensionCommandContext, job: TrackJob) {
	updateSpinnerStatus(ctx, job);
	job.spinnerTimer = setInterval(() => updateSpinnerStatus(ctx, job), SPINNER_INTERVAL_MS);
}

function clearSpinner(ctx?: ExtensionCommandContext) {
	if (activeJob?.spinnerTimer) {
		clearInterval(activeJob.spinnerTimer);
		activeJob.spinnerTimer = undefined;
	}
	ctx?.ui.setStatus(STATUS_KEY, undefined);
}

async function trackPr(pr: PullRequestRef, ctx: ExtensionCommandContext, pi: ExtensionAPI, job: TrackJob) {
	const startedAt = Date.now();
	let attempt = 0;

	ctx.ui.notify(`Tracking ${pr.url}; polling every 60s for Copilot review completion.`, "info");
	startSpinner(ctx, job);

	try {
		while (!job.cancelled) {
			attempt += 1;
			const elapsedMinutes = Math.floor((Date.now() - startedAt) / 60_000);
			updateSpinnerStatus(ctx, job, `Copilot PR review: poll ${attempt}, ${elapsedMinutes}m`);

			const status = await getCopilotStatus(pr, ctx.cwd);
			if (status.finished) {
				clearSpinner(ctx);
				ctx.ui.notify(`Copilot review finished for #${pr.number}: ${status.activitySummary}. Launching pr-review-triage.`, "info");

				const prompt = `/skill:pr-review-triage ${pr.url}`;
				if (ctx.isIdle()) {
					pi.sendUserMessage(prompt);
				} else {
					pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				}
				return;
			}

			const reason = status.hasPendingCopilotRequest
				? `Copilot review is still requested (${status.activitySummary}).`
				: status.hasCopilotActivity
					? `Copilot activity exists but completion is not clear yet (${status.activitySummary}).`
					: "No Copilot activity found yet.";
			ctx.ui.notify(`${reason} Next poll in 60s.`, "info");

			if (Date.now() - startedAt >= DEFAULT_TIMEOUT_MS) {
				throw new Error(`Timed out after ${DEFAULT_TIMEOUT_MS / 60_000} minutes waiting for Copilot on ${pr.url}`);
			}

			await sleep(POLL_INTERVAL_MS, job);
		}
	} catch (error) {
		clearSpinner(ctx);
		ctx.ui.notify(`track-pr failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		if (activeJob === job) activeJob = undefined;
		clearSpinner(ctx);
	}
}

function cancelActiveJob(ctx?: ExtensionCommandContext) {
	if (!activeJob) {
		ctx?.ui.notify("No active track-pr job.", "info");
		return;
	}

	activeJob.cancelled = true;
	if (activeJob.pollTimer) clearTimeout(activeJob.pollTimer);
	clearSpinner(ctx);
	activeJob.wake?.();
	activeJob = undefined;
	ctx?.ui.notify("Cancelled track-pr polling.", "info");
}

export default function trackPrExtension(pi: ExtensionAPI) {
	pi.registerCommand("track-pr", {
		description: "Wait for Copilot to finish reviewing a PR, then run pr-review-triage",
		getArgumentCompletions: (prefix: string) => {
			const commands = ["cancel"];
			const matches = commands.filter((command) => command.startsWith(prefix.trim()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "cancel") {
				cancelActiveJob(ctx);
				return;
			}

			if (activeJob) {
				ctx.ui.notify("A track-pr job is already running. Use /track-pr cancel first.", "warning");
				return;
			}

			const pr = trimmed
				? await resolvePrFromGh(trimmed, ctx.cwd)
				: findRecentPrInSession(ctx) ?? (await resolvePrFromGh("", ctx.cwd));

			if (!pr) {
				ctx.ui.notify(
					"Could not infer a PR. Use /track-pr <GitHub PR URL|number>, or run from a branch with an open GitHub PR.",
					"warning",
				);
				return;
			}

			const job: TrackJob = {
				cancelled: false,
				spinnerFrame: 0,
				statusText: "Copilot PR review: starting",
			};
			activeJob = job;

			void trackPr(pr, ctx, pi, job);
		},
	});

	pi.on("session_shutdown", async () => {
		cancelActiveJob();
	});
}
