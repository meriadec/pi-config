import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TopicMutationResult } from "../daemon/topic-service.ts";
import { createWorkPaths } from "../shared/paths.ts";
import type { WorkClient } from "./client.ts";
import { SystemdWorkdManager, defaultSystemdPaths } from "./systemd.ts";
import {
  PROVISION_TIMEOUT_MS,
  runTopicCreation,
  type CreationConfirmationClient,
  type WorkTopicCreateToolDetails,
} from "./topic-create-runtime.ts";
import {
  resolveTopicCreationInput,
  type ResolvedTopicCreationInput,
  type TopicCreationInput,
} from "./topic-creation.ts";

export type { WorkTopicCreateToolDetails } from "./topic-create-runtime.ts";

const registeredApis = new WeakSet<object>();

const WorkTopicCreateParameters = Type.Object({
  name: Type.String({
    description: "Required display name for the new Topic.",
    minLength: 1,
    maxLength: 200,
  }),
  repository: Type.Optional(
    Type.String({
      description:
        "GitHub repository in exact owner/repo form. Omit it to infer the origin from Source checkout.",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description:
        "Branch for the Topic Worktree. Omit it to make a Git-safe Branch from the Topic name.",
    }),
  ),
  startPoint: Type.Optional(
    Type.String({
      description:
        "Local Git revision, such as HEAD~2, a tag, or a SHA, to resolve as the new Branch start commit.",
    }),
  ),
  sourceCheckout: Type.Optional(
    Type.String({
      description:
        "Local Git checkout used to infer repository and resolve Start Point. Defaults to the Pi working directory.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      description:
        "Maximum time to wait for provisioning, in seconds. Omit it to use the same 600-second deadline as /work.",
      minimum: 1,
      maximum: 3_600,
    }),
  ),
});

export interface TopicCreateToolClient extends CreationConfirmationClient {
  createTopic(
    input: ResolvedTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
}

export interface WorkTopicCreateToolDependencies {
  home?: string;
  runtime?: string;
  timeoutMs?: number;
  resolveInput?: typeof resolveTopicCreationInput;
  connect?: () => Promise<TopicCreateToolClient>;
  requestId?: () => string;
}

export interface WorkTopicCreateInput extends TopicCreationInput {
  timeoutSeconds?: number;
}

/** Register the focused LLM boundary for durable Topic creation and provisioning. */
export function registerWorkTopicCreateTool(
  pi: ExtensionAPI,
  dependencies: WorkTopicCreateToolDependencies = {},
): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);

  pi.registerTool({
    name: "work_topic_create",
    label: "Create Work Topic",
    description:
      "Create and provision one durable work Topic through the same daemon operation as the /work UI. Use it for requests such as ‘Create a work Topic from HEAD~2 named My contribution’ and ‘Create a work Topic for LedgerHQ/revault with Branch foo-bar.’ It resolves repository and Branch defaults, waits for provisioning, and does not open the Topic's Main Agent.",
    promptSnippet: "Create and provision a durable work Topic without opening its Main Agent",
    promptGuidelines: [
      "Use work_topic_create when the user asks to create a work Topic, including ‘Create a work Topic from HEAD~2 named My contribution’ and ‘Create a work Topic for LedgerHQ/revault with Branch foo-bar.’",
      "The name is the Topic display name; repository is owner/repo; branch is the Worktree Branch; startPoint is a local Git revision; sourceCheckout is the checkout used for inference and revision resolution.",
      "Omit each optional work_topic_create argument that the user did not specify. Never send an empty string for repository, branch, startPoint, or sourceCheckout.",
      "With an explicit repository and no Start Point, work_topic_create needs no Source checkout and must not clone or inspect a checkout before calling the tool.",
      "Omit repository and branch when the current Pi working directory should supply the repository and the Topic name should supply the Branch.",
      "Set timeoutSeconds only when the user asks for a specific wait timeout; otherwise omit it to use 600 seconds.",
      "A daemon confirmation-required result always needs a separate direct human dialog. The original request is not confirmation, and this tool has no approval parameter.",
      "The tool creates and provisions the Topic, but it does not open a desktop workspace, terminal, or Main Agent.",
      "Use work_topic_create_child, not work_topic_create, when the new Topic must continue an existing Topic from one of its commits.",
    ],
    parameters: WorkTopicCreateParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWorkTopicCreate(toolCallId, params, signal, onUpdate, ctx, dependencies);
    },
  });
}

/** Resolve the wait deadline that both creation tools share. */
export function creationTimeoutMs(
  dependencyTimeoutMs: number | undefined,
  timeoutSeconds: number | undefined,
): number {
  if (dependencyTimeoutMs !== undefined) return dependencyTimeoutMs;
  return timeoutSeconds === undefined ? PROVISION_TIMEOUT_MS : timeoutSeconds * 1_000;
}

/** Connect to the user's work daemon, starting it through systemd when needed. */
export function connectWorkDaemon(
  home: string | undefined,
  runtime: string | undefined,
): Promise<WorkClient> {
  const resolvedHome = home ?? homedir();
  const paths = createWorkPaths({
    home: resolvedHome,
    ...(runtime === undefined ? {} : { runtime }),
  });
  return new SystemdWorkdManager({
    paths: defaultSystemdPaths(resolvedHome, paths.socket),
    clientId: randomUUID(),
  }).ensureConnected();
}

function normalizeTopicCreationInput(input: WorkTopicCreateInput): TopicCreationInput {
  const repository = nonBlank(input.repository);
  const branch = nonBlank(input.branch);
  const startPoint = nonBlank(input.startPoint);
  const sourceCheckout = nonBlank(input.sourceCheckout);
  return {
    name: input.name,
    ...(repository === undefined ? {} : { repository }),
    ...(branch === undefined ? {} : { branch }),
    ...(startPoint === undefined ? {} : { startPoint }),
    ...(sourceCheckout === undefined ? {} : { sourceCheckout }),
  };
}

/** Drops empty strings, which an LLM sends instead of omitting an optional argument. */
export function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

async function executeWorkTopicCreate(
  _toolCallId: string,
  params: WorkTopicCreateInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
  ctx: ExtensionContext,
  dependencies: WorkTopicCreateToolDependencies,
): Promise<AgentToolResult<WorkTopicCreateToolDetails>> {
  return runTopicCreation<TopicCreateToolClient>({
    ctx,
    signal,
    onUpdate,
    requestId: dependencies.requestId?.() ?? randomUUID(),
    timeoutMs: creationTimeoutMs(dependencies.timeoutMs, params.timeoutSeconds),
    resolve: async () => {
      const normalized = normalizeTopicCreationInput(params);
      const resolved = await (dependencies.resolveInput ?? resolveTopicCreationInput)({
        ...normalized,
        sourceCheckout: normalized.sourceCheckout ?? ctx.cwd,
      });
      return {
        target: { repository: resolved.repository, branch: resolved.branch },
        submit: (client, requestId, timeoutMs) =>
          client.createTopic(resolved, requestId, timeoutMs),
      };
    },
    connect: () =>
      dependencies.connect?.() ?? connectWorkDaemon(dependencies.home, dependencies.runtime),
  });
}
