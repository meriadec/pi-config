import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

export const WORK_DATA_VERSION = 1 as const;

export const ACTION_IDS = [
  "repository.clone",
  "topic.create-worktree",
  "topic.run-setup",
  "terminal.open",
  "agent.open",
  "agent.reset",
  "topic.delete",
] as const;

/** Upper bounds that keep a Repository Recipe small and its lines shell-safe. */
export const MAX_SETUP_COMMANDS = 50;
export const MAX_SETUP_COMMAND_LENGTH = 4_000;

export type ActionId = (typeof ACTION_IDS)[number];
export type ActionPolicy = "allow" | "ask" | "deny";
export type ActionPolicyMap = Partial<Record<ActionId, ActionPolicy>>;

export interface WorkPolicies {
  defaults: ActionPolicyMap;
  repositories: Record<string, ActionPolicyMap>;
  topics: Record<string, ActionPolicyMap>;
}

/** The ordered Setup commands declared for one repository, run to prepare a fresh Worktree. */
export interface RepositoryRecipe {
  setupCommands: string[];
  /**
   * Absolute override for this repository's Base checkout location. When set, the
   * repository's single clone lives at this path instead of `WORK_BASE/<repo-name>`,
   * so a Topic can adopt an existing checkout outside `WORK_BASE` (for example `~/.pi`).
   */
  basePath?: string;
}

export interface WorkConfig {
  version: typeof WORK_DATA_VERSION;
  workBase?: string;
  policies: WorkPolicies;
  repositories: Record<string, RepositoryRecipe>;
}

export interface RepositoryReference {
  owner: string;
  name: string;
  fullName: string;
}

export type SetupState = "provisioning" | "ready" | "setup-failed";
export type MainAgentState =
  | "starting"
  | "thinking"
  | "idle"
  | "tracking-pr"
  | "waiting-for-human"
  | "stopped"
  | "failed";

export interface TopicSetup {
  state: SetupState;
  repositoryAvailable: boolean;
  worktreeCreated: boolean;
  /** The Repository Recipe has run (or was decided unnecessary) for this Worktree. */
  setupCommandsRun: boolean;
  reason?: string;
}

export interface MainAgentReference {
  sessionId: string;
  sessionFile: string | null;
}

/** GitHub lifecycle of a pull request, from the GraphQL `state`. */
export type PullRequestState = "open" | "merged" | "closed";

/** Rollup of the pull request head commit checks, from `statusCheckRollup`. */
export type PullRequestCi = "none" | "pending" | "passing" | "failing";

/** Short display status for the dashboard PR column, ordered by signal. */
export type PullRequestStatus =
  | "merged"
  | "closed"
  | "draft"
  | "ci-failing"
  | "reviewing"
  | "feedback"
  | "checks"
  | "approved"
  | "ready"
  | "clear";

/** One GitHub pull request that belongs to a Topic branch. */
export interface PullRequestRef {
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
  /** Check rollup of the head commit. */
  ci: PullRequestCi;
  /** A requested reviewer (for example Copilot) has not submitted a review yet. */
  reviewPending: boolean;
  /** The Copilot reviewer has submitted a review for the head. */
  copilotReviewed: boolean;
  /** The formal review decision is CHANGES_REQUESTED. */
  changesRequested: boolean;
  /** The formal review decision is APPROVED. */
  approved: boolean;
  /** Count of review threads that are not resolved. */
  unresolvedThreads: number;
}

/**
 * Collapses lifecycle, CI, and review signals into one progressive status.
 * The first matching rule wins, so the highest-signal condition is shown.
 */
export function pullRequestStatus(ref: PullRequestRef): PullRequestStatus {
  if (ref.state === "merged") return "merged";
  if (ref.state === "closed") return "closed";
  if (ref.draft) return "draft";
  if (ref.ci === "failing") return "ci-failing";
  if (ref.changesRequested || ref.unresolvedThreads > 0) return "feedback";
  if (ref.ci === "pending") return "checks";
  // Formal approval takes precedence over reviewer-specific progress signals.
  if (ref.approved) return "approved";
  // Copilot review is done and every thread resolved, even while other reviewers are still requested.
  if (ref.copilotReviewed) return "ready";
  if (ref.reviewPending) return "reviewing";
  return "clear";
}

export interface TopicManifest {
  version: typeof WORK_DATA_VERSION;
  id: string;
  name: string;
  branch: string;
  repository: string;
  setup: TopicSetup;
  worktreePath: string | null;
  mainAgent: MainAgentReference;
  /**
   * Focus partition: Focused Topics render in the hot list on top, Unfocused ones
   * below the separator. A per-Topic attribute, not a container. Absent means Focused,
   * so new Topics and manifests predating Focus start Focused.
   */
  focused: boolean;
  createdAt: string;
  updatedAt: string;
}

export type NewTopic = Pick<TopicManifest, "name" | "branch" | "repository">;

export class WorkDataError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(boundMessage(message));
    this.name = "WorkDataError";
    this.code = code;
  }
}

const MAX_MESSAGE_LENGTH = 200;
const ACTION_ID_SET = new Set<string>(ACTION_IDS);
const POLICY_SET = new Set<string>(["allow", "ask", "deny"]);
const SETUP_STATE_SET = new Set<string>(["provisioning", "ready", "setup-failed"]);
const MAIN_AGENT_STATE_SET = new Set<string>([
  "starting",
  "thinking",
  "idle",
  "tracking-pr",
  "waiting-for-human",
  "stopped",
  "failed",
]);
const TOPIC_KEYS = new Set([
  "version",
  "id",
  "name",
  "branch",
  "repository",
  "setup",
  "worktreePath",
  "mainAgent",
  "focused",
  "createdAt",
  "updatedAt",
]);

export function boundMessage(message: string): string {
  const oneLine = message.replaceAll(/\s+/g, " ").trim();
  return oneLine.length <= MAX_MESSAGE_LENGTH
    ? oneLine
    : `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

export function generateTopicId(): string {
  return randomUUID();
}

export function parseActionPolicy(input: unknown): ActionPolicy {
  if (typeof input !== "string" || !POLICY_SET.has(input)) {
    throw new WorkDataError("invalid-policy", "Action policy must be allow, ask, or deny.");
  }
  return input as ActionPolicy;
}

export function parseSetupState(input: unknown): SetupState {
  if (typeof input !== "string" || !SETUP_STATE_SET.has(input)) {
    throw new WorkDataError("invalid-setup-state", "Topic setup state is invalid.");
  }
  return input as SetupState;
}

export function parseMainAgentState(input: unknown): MainAgentState {
  if (typeof input !== "string" || !MAIN_AGENT_STATE_SET.has(input)) {
    throw new WorkDataError("invalid-main-agent-state", "Main-agent state is invalid.");
  }
  return input as MainAgentState;
}

export function isValidBranchName(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.startsWith("/") ||
    value.startsWith("-") ||
    value === "@" ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("[") ||
    /[~^:?*\\]/.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 32 || code === 127;
    })
  ) {
    return false;
  }
  return value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function parseRepository(input: string): RepositoryReference {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/.exec(input);
  if (!match?.[1] || !match[2] || match[2] === "." || match[2] === "..") {
    throw new WorkDataError(
      "invalid-repository",
      "Repository must have the exact owner/repo form.",
    );
  }
  return { owner: match[1], name: match[2], fullName: input };
}

export function parseWorkConfig(input: unknown): WorkConfig {
  const value = object(input, "Configuration must be a JSON object.");
  requireVersion(value, "configuration");
  const policies = object(value["policies"], "Configuration policies must be an object.");
  const workBase = value["workBase"];
  if (workBase !== undefined && (typeof workBase !== "string" || !isAbsolute(workBase))) {
    throw new WorkDataError("invalid-config", "Configuration workBase must be an absolute path.");
  }

  const defaults = parsePolicyMap(policies["defaults"], "default");
  // Version 1 configurations created before Main Agent reset default to confirmation.
  defaults["agent.reset"] ??= "ask";
  // Configurations created before Repository Recipes default this authored-command action to allow.
  defaults["topic.run-setup"] ??= "allow";
  if (ACTION_IDS.some((action) => defaults[action] === undefined)) {
    throw new WorkDataError(
      "invalid-config",
      "Configuration must define a global policy for each action.",
    );
  }
  const parsed: WorkConfig = {
    version: WORK_DATA_VERSION,
    policies: {
      defaults,
      repositories: parsePolicyOverrides(policies["repositories"], "repository"),
      topics: parsePolicyOverrides(policies["topics"], "topic"),
    },
    repositories: parseRepositoryRecipes(value["repositories"]),
  };
  if (workBase !== undefined) parsed.workBase = workBase;
  return parsed;
}

function parseRepositoryRecipes(input: unknown): Record<string, RepositoryRecipe> {
  if (input === undefined) return {};
  const value = object(input, "Configuration repositories must be an object.");
  const result: Record<string, RepositoryRecipe> = {};
  for (const [key, recipe] of Object.entries(value)) {
    try {
      parseRepository(key);
    } catch {
      throw new WorkDataError("invalid-config", "A repository recipe key is not owner/repo.");
    }
    result[key] = parseRepositoryRecipe(recipe);
  }
  return result;
}

function parseRepositoryRecipe(input: unknown): RepositoryRecipe {
  const value = object(input, "A repository recipe must be an object.");
  const basePath = value["basePath"];
  if (basePath !== undefined && (typeof basePath !== "string" || !isAbsolute(basePath))) {
    throw new WorkDataError(
      "invalid-config",
      "A repository recipe basePath must be an absolute path.",
    );
  }
  const commands = value["setupCommands"] ?? [];
  if (!Array.isArray(commands)) {
    throw new WorkDataError(
      "invalid-config",
      "A repository recipe setupCommands must be an array.",
    );
  }
  if (commands.length > MAX_SETUP_COMMANDS) {
    throw new WorkDataError("invalid-config", "A repository recipe has too many setup commands.");
  }
  const setupCommands = commands.map((command) => {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new WorkDataError("invalid-config", "A setup command must be a non-empty string.");
    }
    if (command.length > MAX_SETUP_COMMAND_LENGTH) {
      throw new WorkDataError("invalid-config", "A setup command is too long.");
    }
    return command;
  });
  const recipe: RepositoryRecipe = { setupCommands };
  if (basePath !== undefined) recipe.basePath = basePath;
  return recipe;
}

/**
 * The Base checkout location of a repository: the per-repository `basePath` override
 * when declared, otherwise `WORK_BASE/<repo-name>`. Returns undefined only when no
 * override exists and no global `workBase` is configured yet.
 */
export function resolveBaseCheckout(
  config: Pick<WorkConfig, "workBase" | "repositories">,
  repository: string,
): string | undefined {
  const override = config.repositories[repository]?.basePath;
  if (override !== undefined) return override;
  if (config.workBase === undefined) return undefined;
  return join(config.workBase, parseRepository(repository).name);
}

export function parseTopicManifest(input: unknown, expectedId?: string): TopicManifest {
  const value = object(input, "Topic manifest must be a JSON object.");
  requireVersion(value, "topic manifest");
  for (const key of Object.keys(value)) {
    if (!TOPIC_KEYS.has(key)) {
      throw new WorkDataError("invalid-topic", `Topic manifest has an unknown field: ${key}.`);
    }
  }

  const id = nonEmptyString(value["id"], "Topic id");
  if (!isTopicId(id))
    throw new WorkDataError("invalid-topic", "Topic id is not a valid opaque session id.");
  if (expectedId !== undefined && id !== expectedId) {
    throw new WorkDataError("invalid-topic", "Topic directory and manifest id do not match.");
  }
  const repository = nonEmptyString(value["repository"], "Topic repository");
  parseRepository(repository);
  const setupValue = object(value["setup"], "Topic setup must be an object.");
  exactKeys(
    setupValue,
    new Set(["state", "repositoryAvailable", "worktreeCreated", "setupCommandsRun", "reason"]),
    "Topic setup",
  );
  const state = parseSetupState(setupValue["state"]);
  const reason = setupValue["reason"];
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.length === 0 || reason.length > 200)
  ) {
    throw new WorkDataError(
      "invalid-topic",
      "Topic setup reason must be a short non-empty string.",
    );
  }
  const worktreePath = nullableString(value["worktreePath"], "Topic worktreePath");
  const mainAgentValue = object(value["mainAgent"], "Topic mainAgent must be an object.");
  exactKeys(mainAgentValue, new Set(["sessionId", "sessionFile"]), "Topic mainAgent");
  const sessionId = nonEmptyString(mainAgentValue["sessionId"], "Main-agent session id");
  if (!isTopicId(sessionId))
    throw new WorkDataError("invalid-topic", "Main-agent session id is invalid.");

  const setup: TopicSetup = {
    state,
    repositoryAvailable: boolean(setupValue["repositoryAvailable"], "repositoryAvailable"),
    worktreeCreated: boolean(setupValue["worktreeCreated"], "worktreeCreated"),
    // A manifest predating Repository Recipes has no flag; its Worktree already
    // exists, so the Recipe is treated as already handled and never runs.
    setupCommandsRun:
      setupValue["setupCommandsRun"] === undefined
        ? true
        : boolean(setupValue["setupCommandsRun"], "setupCommandsRun"),
  };
  if (reason !== undefined) setup.reason = reason;

  const focusedValue = value["focused"];
  if (focusedValue !== undefined && typeof focusedValue !== "boolean") {
    throw new WorkDataError("invalid-topic", "Topic focused must be boolean.");
  }
  // A manifest predating Focus has no flag; it starts Focused in the hot list.
  const focused = focusedValue ?? true;

  return {
    version: WORK_DATA_VERSION,
    id,
    name: nonEmptyString(value["name"], "Topic name"),
    branch: parseBranchName(value["branch"]),
    repository,
    setup,
    worktreePath,
    focused,
    mainAgent: {
      sessionId,
      sessionFile: nullableString(
        value["mainAgent"] && mainAgentValue["sessionFile"],
        "Main-agent sessionFile",
      ),
    },
    createdAt: isoTimestamp(value["createdAt"], "createdAt"),
    updatedAt: isoTimestamp(value["updatedAt"], "updatedAt"),
  };
}

export function isTopicId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function requireVersion(value: Record<string, unknown>, subject: string): void {
  if (value["version"] !== WORK_DATA_VERSION) {
    throw new WorkDataError("unsupported-version", `Unsupported ${subject} version.`);
  }
}

function parsePolicyMap(input: unknown, label: string): ActionPolicyMap {
  const value = object(input, `The ${label} policies must be an object.`);
  const result: ActionPolicyMap = {};
  for (const [action, policy] of Object.entries(value)) {
    if (!ACTION_ID_SET.has(action)) continue;
    try {
      result[action as ActionId] = parseActionPolicy(policy);
    } catch {
      throw new WorkDataError("invalid-config", `The ${label} action policy is invalid.`);
    }
  }
  return result;
}

function parsePolicyOverrides(input: unknown, label: string): Record<string, ActionPolicyMap> {
  const value = object(input, `The ${label} policy overrides must be an object.`);
  const result: Record<string, ActionPolicyMap> = {};
  for (const [key, policies] of Object.entries(value)) {
    if (key.length === 0)
      throw new WorkDataError("invalid-config", `The ${label} policy key is empty.`);
    try {
      if (label === "repository") parseRepository(key);
      if (label === "topic" && !isTopicId(key)) throw new Error("invalid topic id");
    } catch {
      throw new WorkDataError("invalid-config", `The ${label} policy key is invalid.`);
    }
    result[key] = parsePolicyMap(policies, label);
  }
  return result;
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkDataError("invalid-data", message);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WorkDataError("invalid-topic", `${label} must be a non-empty string.`);
  }
  return value;
}

function parseBranchName(value: unknown): string {
  const branch = nonEmptyString(value, "Topic branch");
  if (!isValidBranchName(branch)) {
    throw new WorkDataError("invalid-topic", "Topic branch is not a valid Git branch name.");
  }
  return branch;
}

function nullableString(value: unknown, label: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new WorkDataError("invalid-topic", `${label} must be a string or null.`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new WorkDataError("invalid-topic", `Topic ${label} must be boolean.`);
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new WorkDataError("invalid-topic", `Topic ${label} must be an ISO-8601 timestamp.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new WorkDataError("invalid-topic", `${label} has an unknown field: ${key}.`);
  }
}
