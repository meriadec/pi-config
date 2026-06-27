import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const STATUS_KEY = "ralph-loop";
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_VERIFY_TIMEOUT_MS = 20 * 60_000;
const TERMINAL_STATUSES = new Set(["done", "completed", "closed"]);
const AUTO_VERIFY_SCRIPTS = ["format", "lint", "typecheck", "test:unit", "test"];
const OUTCOME_VALUES = ["completed", "skipped", "needs_human", "blocked"] as const;
const ISSUE_CONTEXT_MARKER_PREFIX = "Ralph Loop issue marker:";

type RalphOutcome = (typeof OUTCOME_VALUES)[number];

type IssueRef = {
	path: string;
	relPath: string;
	title: string;
	status?: string;
	number?: number;
};

type VerifyMode = "auto" | "none" | "commands";

type LoopState = {
	id: string;
	cwd: string;
	repoRoot: string;
	scratchDir: string;
	issues: IssueRef[];
	queue: IssueRef[];
	current?: IssueRef;
	currentAttempt: number;
	startedIssues: number;
	completed: IssueRef[];
	skipped: IssueRef[];
	maxIssues: number;
	maxAttempts: number;
	verifyMode: VerifyMode;
	verifyCommands: string[];
	verifyTimeoutMs: number;
	allowDirty: boolean;
	includeDone: boolean;
	stoppedReason?: string;
	startedAt: number;
};

type StartOptions = {
	selectors: string[];
	maxIssues?: number;
	maxAttempts: number;
	verifyMode: VerifyMode;
	verifyCommands: string[];
	verifyTimeoutMs: number;
	allowDirty: boolean;
	includeDone: boolean;
};

type CommandResult = {
	stdout: string;
	stderr: string;
	code: number;
	killed?: boolean;
};

let activeLoop: LoopState | undefined;

function helpText(): string {
	return [
		"Usage:",
		"  /ralph-loop start [options] <.scratch issue selectors>",
		"  /ralph-loop status",
		"  /ralph-loop stop",
		"  /ralph-loop reset",
		"",
		"Issue selectors are resolved inside the current repo's .scratch/ directory.",
		"Examples:",
		"  /ralph-loop start les-vault:1-3",
		"  /ralph-loop start les-vault:1,3,5-7",
		"  /ralph-loop start .scratch/les-vault/issues/01-exposure-foundation.md",
		"  /ralph-loop start .scratch/les-vault/issues:1-3",
		"  /ralph-loop start .scratch/les-vault/issues",
		"  /ralph-loop start from .scratch/foo-bar, do in order: 08 → 09 → 11 → 10 → 12",
		"",
		"Options:",
		`  --max-attempts <n>        Verification-fix attempts per issue (default ${DEFAULT_MAX_ATTEMPTS})`,
		"  --max-issues <n>          Cap how many selected non-done issues are attempted",
		"  --verify <cmd|auto|none>  Verification command. Repeat for multiple commands. Default: auto",
		`  --verify-timeout <ms>     Timeout per verification command (default ${DEFAULT_VERIFY_TIMEOUT_MS})`,
		"  --include-done            Do not pre-filter Status: done/completed/closed issue files",
		"  --allow-dirty             Start even if git status is dirty",
	].join("\n");
}

function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of input) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function parsePositiveInt(raw: string | undefined, name: string): number {
	if (!raw || !/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer.`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
	return value;
}

function normalizeNaturalOrderArgs(rawArgs: string): string {
	const match = rawArgs.match(/^(.*?)\bfrom\s+(.+?),?\s+do\s+in\s+order:\s*(.+)$/i);
	if (!match) return rawArgs;

	const prefix = match[1]?.trim() ?? "";
	const base = match[2]?.trim().replace(/,$/, "") ?? "";
	const order = match[3] ?? "";
	const numbers = order
		.split(/(?:\s*(?:→|->|,|;)\s*)|\s+/)
		.map((part) => part.trim().replace(/^#/, ""))
		.filter(Boolean);

	if (!base || numbers.length === 0 || numbers.some((part) => !/^\d+$/.test(part))) return rawArgs;
	return [prefix, `${base}:${numbers.join(",")}`].filter(Boolean).join(" ");
}

function parseStartOptions(rawArgs: string): StartOptions {
	const tokens = tokenizeArgs(normalizeNaturalOrderArgs(rawArgs));
	const options: StartOptions = {
		selectors: [],
		maxAttempts: DEFAULT_MAX_ATTEMPTS,
		verifyMode: "auto",
		verifyCommands: [],
		verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
		allowDirty: false,
		includeDone: false,
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		const readValue = (name: string, inline?: string) => {
			if (inline !== undefined) return inline;
			const next = tokens[++i];
			if (!next) throw new Error(`${name} requires a value.`);
			return next;
		};

		if (token === "--allow-dirty") {
			options.allowDirty = true;
			continue;
		}
		if (token === "--include-done") {
			options.includeDone = true;
			continue;
		}
		if (token === "--help" || token === "-h") {
			throw new Error(helpText());
		}

		const optionMatch = token.match(/^(--[^=]+)(?:=(.*))?$/);
		if (optionMatch) {
			const [, name, inline] = optionMatch;
			switch (name) {
				case "--max-issues":
					options.maxIssues = parsePositiveInt(readValue(name, inline), name);
					continue;
				case "--max-attempts":
					options.maxAttempts = parsePositiveInt(readValue(name, inline), name);
					continue;
				case "--verify": {
					const value = readValue(name, inline);
					if (value === "none") {
						options.verifyMode = "none";
						options.verifyCommands = [];
					} else if (value === "auto") {
						options.verifyMode = "auto";
						options.verifyCommands = [];
					} else {
						if (options.verifyMode !== "commands") options.verifyCommands = [];
						options.verifyMode = "commands";
						options.verifyCommands.push(value);
					}
					continue;
				}
				case "--verify-timeout":
					options.verifyTimeoutMs = parsePositiveInt(readValue(name, inline), name);
					continue;
				default:
					throw new Error(`Unknown ralph-loop option: ${name}`);
			}
		}

		options.selectors.push(token);
	}

	if (options.selectors.length === 0) {
		throw new Error("No .scratch issue selector provided.\n\n" + helpText());
	}

	return options;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}

function toRepoRelative(repoRoot: string, filePath: string): string {
	return relative(repoRoot, filePath).split(sep).join("/");
}

function splitSelectorRange(selector: string): { base: string; range?: string } {
	const colon = selector.lastIndexOf(":");
	if (colon === -1) return { base: selector };
	const suffix = selector.slice(colon + 1).trim();
	if (!/^[\d,\-\s]+$/.test(suffix)) return { base: selector };
	return { base: selector.slice(0, colon), range: suffix };
}

function expandRange(range: string): number[] {
	const values = new Set<number>();
	for (const part of range.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		const match = trimmed.match(/^(\d+)(?:-(\d+))?$/);
		if (!match) throw new Error(`Invalid issue range segment: ${trimmed}`);
		const start = Number(match[1]);
		const end = match[2] ? Number(match[2]) : start;
		if (end < start) throw new Error(`Invalid descending issue range: ${trimmed}`);
		for (let value = start; value <= end; value++) values.add(value);
	}
	return [...values];
}

function numericPrefix(fileName: string): number | undefined {
	const match = fileName.match(/^(\d+)(?:[-_\s].*)?\.md$/i);
	return match ? Number(match[1]) : undefined;
}

async function listIssueFiles(directory: string): Promise<IssueRef[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
		.map((entry) => join(directory, entry.name));
	files.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));
	return Promise.all(files.map((file) => readIssue(file)));
}

async function issueDirectoryFor(basePath: string): Promise<string> {
	const info = await stat(basePath).catch(() => undefined);
	if (!info) throw new Error(`Issue selector does not exist: ${basePath}`);
	if (!info.isDirectory()) throw new Error(`Issue range selector must point to a directory: ${basePath}`);

	const nestedIssues = join(basePath, "issues");
	if (await pathExists(nestedIssues)) {
		const nestedInfo = await stat(nestedIssues);
		if (nestedInfo.isDirectory()) return nestedIssues;
	}
	return basePath;
}

async function readIssue(filePath: string): Promise<IssueRef> {
	const text = await readFile(filePath, "utf8");
	const title = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || basename(filePath, ".md");
	const status = text.match(/^Status:\s*(.+)$/im)?.[1]?.trim();
	return {
		path: filePath,
		relPath: filePath,
		title,
		status,
		number: numericPrefix(basename(filePath)),
	};
}

async function resolveBasePath(base: string, repoRoot: string, scratchDir: string): Promise<string> {
	if (!base.trim()) throw new Error("Empty issue selector base.");

	const candidates: string[] = [];
	if (isAbsolute(base)) {
		candidates.push(resolve(base));
	} else {
		candidates.push(resolve(repoRoot, base));
		if (!base.startsWith(`.scratch/`) && base !== ".scratch") {
			candidates.push(resolve(scratchDir, base));
			if (!base.includes("/")) candidates.push(resolve(scratchDir, base, "issues"));
		}
	}

	let existingOutsideScratch: string | undefined;
	for (const candidate of candidates) {
		if (!(await pathExists(candidate))) continue;
		if (isInside(candidate, scratchDir)) return candidate;
		existingOutsideScratch = candidate;
	}

	if (existingOutsideScratch) throw new Error(`Issue selector escapes .scratch/: ${base}`);
	throw new Error(`Could not resolve issue selector inside .scratch/: ${base}`);
}

async function resolveSelector(selector: string, repoRoot: string, scratchDir: string): Promise<IssueRef[]> {
	const { base, range } = splitSelectorRange(selector);
	const basePath = await resolveBasePath(base, repoRoot, scratchDir);
	if (!isInside(basePath, scratchDir)) {
		throw new Error(`Issue selector escapes .scratch/: ${selector}`);
	}

	const info = await stat(basePath);
	let issues: IssueRef[];
	if (range) {
		const issueDir = await issueDirectoryFor(basePath);
		if (!isInside(issueDir, scratchDir)) throw new Error(`Issue selector escapes .scratch/: ${selector}`);
		const available = await listIssueFiles(issueDir);
		const byNumber = new Map<number, IssueRef[]>();
		for (const issue of available) {
			if (issue.number === undefined) continue;
			const group = byNumber.get(issue.number) ?? [];
			group.push(issue);
			byNumber.set(issue.number, group);
		}

		issues = [];
		for (const number of expandRange(range)) {
			const matches = byNumber.get(number) ?? [];
			if (matches.length === 0) throw new Error(`No .scratch issue file with numeric prefix ${number} in ${issueDir}`);
			if (matches.length > 1) {
				throw new Error(`Multiple .scratch issue files with numeric prefix ${number} in ${issueDir}`);
			}
			issues.push(matches[0]!);
		}
	} else if (info.isDirectory()) {
		const issueDir = await issueDirectoryFor(basePath);
		issues = await listIssueFiles(issueDir);
	} else if (info.isFile() && basePath.toLowerCase().endsWith(".md")) {
		issues = [await readIssue(basePath)];
	} else {
		throw new Error(`Issue selector must resolve to a markdown file or directory: ${selector}`);
	}

	return issues.map((issue) => ({ ...issue, relPath: toRepoRelative(repoRoot, issue.path) }));
}

async function resolveIssueSelectors(selectors: string[], repoRoot: string, scratchDir: string): Promise<IssueRef[]> {
	const issues: IssueRef[] = [];
	const seen = new Set<string>();
	for (const selector of selectors) {
		for (const issue of await resolveSelector(selector, repoRoot, scratchDir)) {
			if (seen.has(issue.path)) continue;
			seen.add(issue.path);
			issues.push(issue);
		}
	}
	return issues;
}

function isTerminalStatus(status: string | undefined): boolean {
	return status !== undefined && TERMINAL_STATUSES.has(status.trim().toLowerCase());
}

async function repoRoot(pi: ExtensionAPI): Promise<string> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 10_000 }) as CommandResult;
	if (result.code !== 0) throw new Error("ralph-loop must run inside a git repository.");
	return result.stdout.trim();
}

function gitArgs(repoRootPath: string, args: string[]): string[] {
	return ["-C", repoRootPath, ...args];
}

async function gitStatus(pi: ExtensionAPI, repoRootPath: string): Promise<string> {
	const result = await pi.exec("git", gitArgs(repoRootPath, ["status", "--porcelain"]), { timeout: 10_000 }) as CommandResult;
	if (result.code !== 0) throw new Error(result.stderr.trim() || "git status failed");
	return result.stdout.trim();
}

async function ensureNoMergeState(pi: ExtensionAPI, repoRootPath: string): Promise<void> {
	const unmerged = await pi.exec("git", gitArgs(repoRootPath, ["diff", "--name-only", "--diff-filter=U"]), { timeout: 10_000 }) as CommandResult;
	if (unmerged.code !== 0) throw new Error(unmerged.stderr.trim() || "Failed to inspect unmerged git paths.");
	if (unmerged.stdout.trim()) throw new Error(`Unmerged git paths exist:\n${unmerged.stdout.trim()}`);
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

async function discoverAutoVerifyCommands(repoRootPath: string): Promise<string[]> {
	const packageJsonPath = join(repoRootPath, "package.json");
	if (!(await pathExists(packageJsonPath))) return [];

	const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
		packageManager?: string;
		scripts?: Record<string, string>;
	};
	const scripts = packageJson.scripts ?? {};
	const manager = await detectPackageManager(repoRootPath, packageJson.packageManager);
	return AUTO_VERIFY_SCRIPTS
		.filter((script) => Object.prototype.hasOwnProperty.call(scripts, script))
		.map((script) => manager === "yarn" ? `yarn ${script}` : `${manager} run ${script}`);
}

async function detectPackageManager(repoRootPath: string, packageManager?: string): Promise<"bun" | "pnpm" | "yarn" | "npm"> {
	const declared = packageManager?.split("@")[0];
	if (declared === "bun" || declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
	if (await pathExists(join(repoRootPath, "bun.lock")) || await pathExists(join(repoRootPath, "bun.lockb"))) return "bun";
	if (await pathExists(join(repoRootPath, "pnpm-lock.yaml"))) return "pnpm";
	if (await pathExists(join(repoRootPath, "yarn.lock"))) return "yarn";
	return "npm";
}

function truncateText(text: string, maxChars = 8000): string {
	if (text.length <= maxChars) return text;
	return text.slice(0, maxChars) + `\n...[truncated ${text.length - maxChars} chars]`;
}

async function runVerification(pi: ExtensionAPI, state: LoopState, signal?: AbortSignal) {
	if (state.verifyMode === "none") {
		return { ok: true, output: "Verification disabled by --verify none." };
	}

	if (state.verifyCommands.length === 0) {
		return { ok: true, output: "No extension verification commands were discovered or configured." };
	}

	const chunks: string[] = [];
	for (const command of state.verifyCommands) {
		chunks.push(`$ ${command}`);
		const result = await pi.exec("bash", ["-lc", `cd ${shellQuote(state.repoRoot)} && ${command}`], { timeout: state.verifyTimeoutMs, signal }) as CommandResult;
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		if (output) chunks.push(truncateText(output));
		chunks.push(`exit code: ${result.code}${result.killed ? " (killed/timeout)" : ""}`);
		if (result.code !== 0) {
			return { ok: false, output: chunks.join("\n\n") };
		}
	}

	return { ok: true, output: chunks.join("\n\n") };
}

function safeCommitMessage(raw: string | undefined, issue: IssueRef): string {
	const trimmed = raw?.trim();
	if (!trimmed) return `fix: address ${issue.title}`.slice(0, 200);
	const lines = trimmed.split(/\r?\n/).map((line) => line.trimEnd());
	const subject = (lines[0] || `fix: address ${issue.title}`).slice(0, 200);
	return [subject, ...lines.slice(1)].join("\n").trim();
}

async function markIssueDone(issue: IssueRef): Promise<boolean> {
	const current = await readFile(issue.path, "utf8");
	let next: string;
	if (/^Status:\s*.*$/im.test(current)) {
		next = current.replace(/^Status:\s*.*$/im, "Status: done");
	} else {
		const lines = current.split(/\r?\n/);
		const insertAt = lines[0]?.startsWith("#") ? 1 : 0;
		lines.splice(insertAt, 0, "", "Status: done");
		next = lines.join("\n");
	}
	if (next === current) return false;
	await writeFile(issue.path, next, "utf8");
	issue.status = "done";
	return true;
}

async function commitCurrentIssue(pi: ExtensionAPI, state: LoopState, issue: IssueRef, commitMessage: string): Promise<string> {
	const add = await pi.exec("git", gitArgs(state.repoRoot, ["add", "-A"]), { timeout: 60_000 }) as CommandResult;
	if (add.code !== 0) throw new Error(add.stderr.trim() || "git add failed");

	const commit = await pi.exec(
		"git",
		gitArgs(state.repoRoot, ["-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", "commit", "--no-gpg-sign", "-m", commitMessage]),
		{ timeout: 120_000 },
	) as CommandResult;
	if (commit.code !== 0) throw new Error(commit.stderr.trim() || commit.stdout.trim() || "git commit failed");
	return [commit.stdout, commit.stderr].filter(Boolean).join("\n").trim();
}

function formatIssueLine(issue: IssueRef): string {
	const number = issue.number === undefined ? "" : `#${issue.number} `;
	const status = issue.status ? ` [${issue.status}]` : "";
	return `${number}${issue.relPath}${status} — ${issue.title}`;
}

function formatLoopStatus(state: LoopState): string {
	const current = state.current ? `${state.current.relPath} attempt ${state.currentAttempt}/${state.maxAttempts}` : "none";
	return [
		`Ralph Loop ${state.stoppedReason ? "stopped" : "running"}`,
		`Current: ${current}`,
		`Started: ${state.startedIssues}/${state.maxIssues}`,
		`Completed: ${state.completed.length}`,
		`Skipped: ${state.skipped.length}`,
		`Remaining: ${state.queue.length}`,
		`Verification: ${state.verifyMode === "commands" || state.verifyCommands.length ? state.verifyCommands.join(" && ") : state.verifyMode}`,
		state.stoppedReason ? `Reason: ${state.stoppedReason}` : undefined,
	].filter(Boolean).join("\n");
}

function updateStatus(ctx: { ui: { setStatus: (key: string, value: string | undefined) => void } }, state?: LoopState) {
	if (!state) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		return;
	}

	if (state.stoppedReason) {
		ctx.ui.setStatus(STATUS_KEY, `stopped: ${state.stoppedReason.slice(0, 40)}`);
		return;
	}

	const current = state.current ? `${state.current.number ?? basename(state.current.path, ".md")} ${state.currentAttempt}/${state.maxAttempts}` : "starting";
	ctx.ui.setStatus(STATUS_KEY, `ralph ${state.completed.length}✓ ${state.skipped.length}↷ ${state.queue.length}… ${current}`);
}

function appendState(pi: ExtensionAPI, event: string, data: Record<string, unknown> = {}) {
	try {
		pi.appendEntry("ralph-loop", { event, at: new Date().toISOString(), ...data });
	} catch {
		// State snapshots are best-effort session annotations.
	}
}

function stopLoop(pi: ExtensionAPI, ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; notify?: (message: string, level: "info" | "warning" | "error") => void } }, reason: string) {
	if (!activeLoop) return;
	activeLoop.stoppedReason = reason;
	appendState(pi, "stopped", { reason, status: formatLoopStatus(activeLoop) });
	updateStatus(ctx, activeLoop);
	ctx.ui.notify?.(`Ralph Loop stopped: ${reason}`, "warning");
}

function finishLoop(pi: ExtensionAPI, ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; notify?: (message: string, level: "info" | "warning" | "error") => void } }) {
	if (!activeLoop) return;
	const summary = formatLoopStatus(activeLoop).replace("Ralph Loop running", "Ralph Loop done");
	appendState(pi, "done", { status: summary });
	ctx.ui.setStatus(STATUS_KEY, undefined);
	ctx.ui.notify?.(`Ralph Loop done. Completed ${activeLoop.completed.length}, skipped ${activeLoop.skipped.length}.`, "info");
	activeLoop = undefined;
}

function sendUserMessage(pi: ExtensionAPI, ctx: { isIdle?: () => boolean }, message: string) {
	if (ctx.isIdle?.()) pi.sendUserMessage(message);
	else pi.sendUserMessage(message, { deliverAs: "followUp" });
}

function issueContextMarker(state: LoopState, issue: IssueRef): string {
	return `${ISSUE_CONTEXT_MARKER_PREFIX} ${state.id}:${issue.relPath}:attempt-${state.currentAttempt}`;
}

function containsText(value: unknown, needle: string, seen = new WeakSet<object>()): boolean {
	if (typeof value === "string") return value.includes(needle);
	if (!value || typeof value !== "object") return false;
	if (seen.has(value)) return false;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => containsText(item, needle, seen));
	return Object.values(value as Record<string, unknown>).some((item) => containsText(item, needle, seen));
}

function issuePrompt(state: LoopState, issue: IssueRef, retryContext?: string): string {
	const verification = state.verifyCommands.length
		? state.verifyCommands.map((command) => `- ${command}`).join("\n")
		: state.verifyMode === "none"
			? "- Extension verification disabled by --verify none. Run targeted validation yourself before reporting completed."
			: "- No automatic verification command was discovered. Run targeted repo validation yourself before reporting completed.";

	return [
		"You are running Ralph Loop, an autonomous local .scratch issue loop.",
		"",
		`Repo root: ${state.repoRoot}`,
		`Current issue file: ${issue.relPath}`,
		issueContextMarker(state, issue),
		`Issue title: ${issue.title}`,
		`Attempt: ${state.currentAttempt}/${state.maxAttempts}`,
		`Selected issue ${state.startedIssues}/${state.maxIssues}; remaining after this: ${state.queue.length}`,
		"",
		retryContext ? `Previous verification failed. Fix the failure before calling ralph_issue_result again.\n\n${retryContext}` : undefined,
		"Rules:",
		"1. The issue file under .scratch/ is the source of truth for this task. Read it first.",
		"2. Work autonomously. Do not ask for approval before implementation.",
		"3. Stop instead of guessing if the issue needs product judgment, secrets, external access, destructive actions, or an important unresolved ambiguity.",
		"4. Do not manually commit, amend, tag, push, or alter git history. The Ralph Loop extension owns verification and unsigned commits.",
		"5. You may run targeted tests/checks while working, but the extension will run final verification after you call ralph_issue_result.",
		"6. Do not move to another issue yourself. Do not loop manually.",
		"7. When this issue reaches a terminal state, call ralph_issue_result as your final action. Do not provide a normal final answer instead.",
		"",
		"Call ralph_issue_result with:",
		"- outcome=completed only after implementing the issue and any targeted validation you judge necessary.",
		"- outcome=skipped if the issue is already done, not legitimate, not actionable, or outside the repo's current scope.",
		"- outcome=needs_human if meaningful human judgment/input is required.",
		"- outcome=blocked if an unexpected/unfixable technical failure prevents progress.",
		"",
		"For completed, include a concise conventional-commit commitMessage. The extension will mark the issue Status as done, run verification, stage all changes, and commit with --no-gpg-sign.",
		"",
		"Extension verification commands:",
		verification,
	].filter(Boolean).join("\n");
}

function startNextIssue(pi: ExtensionAPI, ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; notify?: (message: string, level: "info" | "warning" | "error") => void }; isIdle?: () => boolean }) {
	const state = activeLoop;
	if (!state) return;
	if (state.stoppedReason) return;

	if (state.startedIssues >= state.maxIssues || state.queue.length === 0) {
		finishLoop(pi, ctx);
		return;
	}

	const issue = state.queue.shift()!;
	state.current = issue;
	state.currentAttempt = 1;
	state.startedIssues += 1;
	appendState(pi, "issue-start", { issue: issue.relPath, attempt: state.currentAttempt });
	updateStatus(ctx, state);
	sendUserMessage(pi, ctx, issuePrompt(state, issue));
}

async function handleCompleted(pi: ExtensionAPI, params: { summary: string; commitMessage?: string }, ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; notify?: (message: string, level: "info" | "warning" | "error") => void }; isIdle?: () => boolean; signal?: AbortSignal }) {
	const state = activeLoop;
	const issue = state?.current;
	if (!state || !issue) throw new Error("No active Ralph Loop issue.");

	appendState(pi, "issue-result", { issue: issue.relPath, outcome: "completed", summary: params.summary });
	updateStatus(ctx, state);
	await ensureNoMergeState(pi, state.repoRoot);

	let statusBeforeVerify = await gitStatus(pi, state.repoRoot);
	if (!statusBeforeVerify) {
		stopLoop(pi, ctx, `Issue ${issue.relPath} was reported completed but produced no git changes.`);
		return "Stopped: completed issue produced no git changes.";
	}

	ctx.ui.notify?.(`Ralph Loop verifying ${issue.relPath}`, "info");
	const verification = await runVerification(pi, state, ctx.signal);
	if (!verification.ok) {
		appendState(pi, "verification-failed", { issue: issue.relPath, attempt: state.currentAttempt, output: verification.output });
		if (state.currentAttempt >= state.maxAttempts) {
			stopLoop(pi, ctx, `Verification failed for ${issue.relPath} after ${state.currentAttempt}/${state.maxAttempts} attempts.`);
			return `Verification failed and max attempts were exhausted.\n\n${verification.output}`;
		}

		state.currentAttempt += 1;
		updateStatus(ctx, state);
		const retryContext = truncateText(verification.output, 6000);
		sendUserMessage(pi, ctx, issuePrompt(state, issue, retryContext));
		return `Verification failed. Queued retry ${state.currentAttempt}/${state.maxAttempts}.`;
	}

	await markIssueDone(issue);
	statusBeforeVerify = await gitStatus(pi, state.repoRoot);
	if (!statusBeforeVerify) {
		stopLoop(pi, ctx, `Issue ${issue.relPath} has no changes to commit after verification.`);
		return "Stopped: no changes to commit.";
	}

	const message = safeCommitMessage(params.commitMessage, issue);
	ctx.ui.notify?.(`Ralph Loop committing ${issue.relPath} without GPG signing`, "info");
	const commitOutput = await commitCurrentIssue(pi, state, issue, message);

	state.completed.push(issue);
	state.current = undefined;
	appendState(pi, "issue-committed", {
		issue: issue.relPath,
		commitMessage: message,
		verification: verification.output,
		commitOutput,
	});
	updateStatus(ctx, state);
	startNextIssue(pi, ctx);
	return [`Completed ${issue.relPath}.`, "", "Verification:", verification.output, "", "Commit:", commitOutput].join("\n");
}

async function handleSkippedOrBlocked(pi: ExtensionAPI, outcome: Exclude<RalphOutcome, "completed">, params: { summary: string }, ctx: { ui: { setStatus: (key: string, value: string | undefined) => void; notify?: (message: string, level: "info" | "warning" | "error") => void }; isIdle?: () => boolean }) {
	const state = activeLoop;
	const issue = state?.current;
	if (!state || !issue) throw new Error("No active Ralph Loop issue.");

	appendState(pi, "issue-result", { issue: issue.relPath, outcome, summary: params.summary });
	const status = await gitStatus(pi, state.repoRoot);
	if (status) {
		stopLoop(pi, ctx, `${outcome} for ${issue.relPath} left a dirty git tree. Human review required.`);
		return `Stopped: outcome=${outcome} left dirty git changes.\n\n${status}`;
	}

	if (outcome === "skipped") {
		state.skipped.push(issue);
		state.current = undefined;
		updateStatus(ctx, state);
		startNextIssue(pi, ctx);
		return `Skipped ${issue.relPath}. Queued next issue if any.`;
	}

	stopLoop(pi, ctx, `${outcome} for ${issue.relPath}: ${params.summary}`);
	return `Stopped: ${outcome} for ${issue.relPath}.`;
}

async function startLoop(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext) {
	if (activeLoop && !activeLoop.stoppedReason) {
		ctx.ui.notify("A Ralph Loop is already running. Use /ralph-loop stop first.", "warning");
		return;
	}

	const options = parseStartOptions(args);
	const root = await repoRoot(pi);
	const scratchDir = join(root, ".scratch");
	if (!(await pathExists(scratchDir))) throw new Error(`No .scratch/ directory found at ${scratchDir}`);

	if (!options.allowDirty) {
		const status = await gitStatus(pi, root);
		if (status) {
			throw new Error(`Refusing to start Ralph Loop from a dirty git tree. Commit/stash first or pass --allow-dirty.\n\n${status}`);
		}
	}

	let issues = await resolveIssueSelectors(options.selectors, root, scratchDir);
	if (!options.includeDone) issues = issues.filter((issue) => !isTerminalStatus(issue.status));
	if (issues.length === 0) {
		ctx.ui.notify("No non-done .scratch issues matched the selector(s).", "info");
		return;
	}

	const verifyCommands = options.verifyMode === "auto" ? await discoverAutoVerifyCommands(root) : options.verifyCommands;
	const maxIssues = Math.min(options.maxIssues ?? issues.length, issues.length);
	activeLoop = {
		id: `${Date.now()}`,
		cwd: ctx.cwd,
		repoRoot: root,
		scratchDir,
		issues,
		queue: issues.slice(),
		currentAttempt: 0,
		startedIssues: 0,
		completed: [],
		skipped: [],
		maxIssues,
		maxAttempts: options.maxAttempts,
		verifyMode: options.verifyMode,
		verifyCommands,
		verifyTimeoutMs: options.verifyTimeoutMs,
		allowDirty: options.allowDirty,
		includeDone: options.includeDone,
		startedAt: Date.now(),
	};

	appendState(pi, "start", {
		repoRoot: root,
		issues: issues.map((issue) => issue.relPath),
		maxIssues,
		maxAttempts: options.maxAttempts,
		verifyCommands,
	});
	ctx.ui.notify(`Ralph Loop starting with ${maxIssues}/${issues.length} selected .scratch issues.`, "info");
	updateStatus(ctx, activeLoop);
	startNextIssue(pi, ctx);
}

function statusCommand(ctx: ExtensionCommandContext) {
	if (!activeLoop) {
		ctx.ui.notify("No active Ralph Loop.", "info");
		return;
	}

	const lines = [formatLoopStatus(activeLoop), "", "Selected issues:", ...activeLoop.issues.map((issue) => `- ${formatIssueLine(issue)}`)];
	ctx.ui.notify(lines.join("\n"), activeLoop.stoppedReason ? "warning" : "info");
}

function stopCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
	if (!activeLoop) {
		ctx.ui.notify("No active Ralph Loop.", "info");
		return;
	}
	stopLoop(pi, ctx, "Stopped by user.");
	activeLoop = undefined;
	ctx.ui.setStatus(STATUS_KEY, undefined);
}

export default function ralphLoopExtension(pi: ExtensionAPI) {
	pi.registerCommand("ralph-loop", {
		description: "Run an autonomous Ralph Loop over explicitly selected local .scratch issue files",
		getArgumentCompletions: (prefix: string) => {
			const commands = ["start", "status", "stop", "reset", "help"];
			const trimmed = prefix.trim();
			if (trimmed.includes(" ")) return null;
			const matches = commands.filter((command) => command.startsWith(trimmed));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const commandMatch = trimmed.match(/^(start|status|stop|reset|help)(?:\s+|$)/);
			const command = commandMatch?.[1] ?? (trimmed ? "start" : "help");
			const commandArgs = commandMatch ? trimmed.slice(commandMatch[0].length).trim() : trimmed;

			try {
				switch (command) {
					case "start":
						await startLoop(pi, commandArgs, ctx);
						return;
					case "status":
						statusCommand(ctx);
						return;
					case "stop":
					case "reset":
						stopCommand(pi, ctx);
						return;
					case "help":
						ctx.ui.notify(helpText(), "info");
						return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, message.startsWith("Usage:") ? "info" : "error");
			}
		},
	});

	pi.registerTool({
		name: "ralph_issue_result",
		label: "Ralph Issue Result",
		description: "Report the terminal result for the current Ralph Loop .scratch issue. Use only when a Ralph Loop issue is completed, skipped, needs human input, or is blocked.",
		promptSnippet: "Report the terminal result for the current Ralph Loop issue",
		promptGuidelines: [
			"Use ralph_issue_result as the final action for each Ralph Loop issue; do not commit manually or move to the next issue yourself.",
			"Use ralph_issue_result outcome=needs_human instead of guessing when a Ralph Loop issue needs meaningful human judgment.",
		],
		parameters: Type.Object({
			outcome: StringEnum(OUTCOME_VALUES),
			summary: Type.String({ description: "Concise summary of what happened and why this outcome is correct." }),
			commitMessage: Type.Optional(Type.String({ description: "Required for completed: concise conventional-commit message for the extension-owned unsigned commit." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!activeLoop || !activeLoop.current) {
				return {
					content: [{ type: "text", text: "No active Ralph Loop issue. Do not call ralph_issue_result outside /ralph-loop." }],
					terminate: true,
				};
			}

			const toolCtx = { ...ctx, signal };
			let text: string;
			if (params.outcome === "completed") {
				text = await handleCompleted(pi, params, toolCtx);
			} else {
				text = await handleSkippedOrBlocked(pi, params.outcome, params, toolCtx);
			}

			return {
				content: [{ type: "text", text }],
				details: { outcome: params.outcome, active: activeLoop ? formatLoopStatus(activeLoop) : "done" },
				terminate: true,
			};
		},
	});

	pi.on("context", async (event) => {
		const state = activeLoop;
		if (!state?.current) return;

		const markerNeedle = `${ISSUE_CONTEXT_MARKER_PREFIX} ${state.id}:${state.current.relPath}:`;
		let startIndex = -1;
		for (let i = event.messages.length - 1; i >= 0; i--) {
			if (containsText(event.messages[i], markerNeedle)) {
				startIndex = i;
				break;
			}
		}

		if (startIndex === -1) return;
		return { messages: event.messages.slice(startIndex) };
	});

	pi.on("tool_call", async (event) => {
		if (!activeLoop || event.toolName !== "bash") return;
		const input = event.input as { command?: string };
		const command = input.command ?? "";
		if (/\bgit\s+(?:[^;&|]*\s+)?commit\b/.test(command)) {
			return { block: true, reason: "Ralph Loop owns commits and will commit unsigned after verification. Do not run git commit manually." };
		}
	});

	pi.on("session_shutdown", async () => {
		activeLoop = undefined;
	});
}
