import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkEvent } from "../daemon/protocol.ts";
import type { ConfirmationRequirement, TopicMutationResult } from "../daemon/topic-service.ts";
import { boundMessage } from "../shared/domain.ts";
import type { TopicManifest } from "../shared/domain.ts";
import { createWorkPaths } from "../shared/paths.ts";
import { SystemdWorkdManager, defaultSystemdPaths } from "./systemd.ts";
import {
  resolveTopicCreationInput,
  type ResolvedTopicCreationInput,
  type TopicCreationInput,
} from "./topic-creation.ts";

const PROVISION_TIMEOUT_MS = 6 * 60 * 60 * 1_000;
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
});

export interface TopicCreateToolClient {
  createTopic(
    input: ResolvedTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  confirm(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  reject(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  subscribe(handler: (event: WorkEvent) => void, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export interface WorkTopicCreateToolDependencies {
  home?: string;
  runtime?: string;
  timeoutMs?: number;
  resolveInput?: typeof resolveTopicCreationInput;
  connect?: () => Promise<TopicCreateToolClient>;
  requestId?: () => string;
}

export interface WorkTopicCreateToolDetails {
  status: string;
  topicId?: string;
  repository?: string;
  branch?: string;
  setupState?: string;
  worktreePath?: string | null;
  action?: string;
  confirmationText?: string;
  code?: string;
  message?: string;
  phase?: string;
  existingTopicId?: string;
  existingTopicName?: string;
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
      "Create and provision one durable work Topic. Use it for requests such as ‘Create a work Topic from HEAD~2 named My contribution’ and ‘Create a work Topic for LedgerHQ/revault with Branch foo-bar.’ It resolves repository and Branch defaults, waits for provisioning, and does not open the Topic's Main Agent.",
    promptSnippet: "Create and provision a durable work Topic without opening its Main Agent",
    promptGuidelines: [
      "Use work_topic_create when the user asks to create a work Topic, including ‘Create a work Topic from HEAD~2 named My contribution’ and ‘Create a work Topic for LedgerHQ/revault with Branch foo-bar.’",
      "The name is the Topic display name; repository is owner/repo; branch is the Worktree Branch; startPoint is a local Git revision; sourceCheckout is the checkout used for inference and revision resolution.",
      "Omit repository and branch when the current Pi working directory should supply the repository and the Topic name should supply the Branch.",
      "A daemon confirmation-required result always needs a separate direct human dialog. The original request is not confirmation, and this tool has no approval parameter.",
      "The tool creates and provisions the Topic, but it does not open a desktop workspace, terminal, or Main Agent.",
    ],
    parameters: WorkTopicCreateParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWorkTopicCreate(toolCallId, params, signal, onUpdate, ctx, dependencies);
    },
  });
}

async function executeWorkTopicCreate(
  toolCallId: string,
  params: TopicCreationInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
  ctx: ExtensionContext,
  dependencies: WorkTopicCreateToolDependencies,
): Promise<AgentToolResult<WorkTopicCreateToolDetails>> {
  let client: TopicCreateToolClient | undefined;
  const requestId = dependencies.requestId?.() ?? `${toolCallId}:${randomUUID()}`;
  const timeoutMs = dependencies.timeoutMs ?? PROVISION_TIMEOUT_MS;
  const progress = progressReporter(onUpdate);

  try {
    throwIfAborted(signal);
    progress("resolve", "Resolving Topic input.");
    const resolved = await abortable(
      (dependencies.resolveInput ?? resolveTopicCreationInput)({
        ...params,
        sourceCheckout: params.sourceCheckout ?? ctx.cwd,
      }),
      signal,
    );

    progress("connect", "Connecting to the work daemon.");
    const connecting =
      dependencies.connect?.() ??
      (() => {
        const home = dependencies.home ?? homedir();
        const paths = createWorkPaths({
          home,
          ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
        });
        return new SystemdWorkdManager({
          paths: defaultSystemdPaths(home, paths.socket),
          clientId: randomUUID(),
        }).ensureConnected();
      })();
    if (signal !== undefined) {
      void connecting
        .then((connected) => {
          if (signal.aborted) connected.close();
        })
        .catch(() => undefined);
    }
    client = await abortable(connecting, signal);

    await abortable(
      client.subscribe((event) => reportDaemonProgress(event, progress), 2_000),
      signal,
      () => client?.close(),
    );
    progress("provision", "Provisioning the Topic.");
    let result = await abortable(client.createTopic(resolved, requestId, timeoutMs), signal, () =>
      client?.close(),
    );

    let confirmationIndex = 0;
    while (result.status === "confirmation-required") {
      if (!ctx.hasUI) return confirmationResult(result, resolved);
      throwIfAborted(signal);
      const approved = await ctx.ui.confirm(
        "Confirm work Topic provisioning",
        result.text,
        signal === undefined ? undefined : { signal },
      );
      throwIfAborted(signal);
      confirmationIndex += 1;
      const confirmationRequest = `${requestId}:${approved ? "confirm" : "reject"}:${confirmationIndex}`;
      result = await abortable(
        approved
          ? client.confirm(result.token, confirmationRequest, timeoutMs)
          : client.reject(result.token, confirmationRequest, timeoutMs),
        signal,
        () => client?.close(),
      );
      if (!approved) break;
    }
    if (result.status === "confirmation-required") return confirmationResult(result, resolved);

    return mutationResult(result, resolved);
  } catch (error) {
    if (signal?.aborted || error instanceof ToolCancelledError) {
      return failureResult("cancelled", "Topic creation was cancelled.");
    }
    return errorResult(error);
  } finally {
    client?.close();
  }
}

function progressReporter(
  onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
): (phase: string, text: string) => void {
  const emitted = new Set<string>();
  return (phase, text) => {
    const key = `${phase}\0${text}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    // A daemon Recipe has at most 50 steps; cap all other repeated event detail too.
    if (emitted.size > 64) return;
    onUpdate?.({ content: [{ type: "text", text }], details: { status: "running", phase } });
  };
}

function reportDaemonProgress(
  event: WorkEvent,
  report: (phase: string, text: string) => void,
): void {
  if (event.type === "topic-added") {
    report("clone", "Preparing the repository clone.");
    return;
  }
  if (event.type === "operation-changed" && event.operation?.detail?.startsWith("setup ")) {
    report(event.operation.detail, `${event.operation.detail}.`);
    return;
  }
  if (
    (event.type === "setup-changed" || event.type === "topic-changed") &&
    event.topic.setup.worktreeCreated
  ) {
    report("worktree", "Created the Topic Worktree.");
  }
}

function mutationResult(
  result: Exclude<TopicMutationResult, ConfirmationRequirement>,
  resolved: ResolvedTopicCreationInput,
): AgentToolResult<WorkTopicCreateToolDetails> {
  if (result.status === "ready") return readyResult(result.topic);
  const topic = "topic" in result ? result.topic : undefined;
  const reason = "reason" in result ? result.reason : `Topic creation ${result.status}.`;
  const details: WorkTopicCreateToolDetails = {
    status: result.status,
    ...(topic === undefined ? {} : topicDetails(topic)),
    ...(topic === undefined ? { repository: resolved.repository, branch: resolved.branch } : {}),
    ...(result.status === "rejected" ? { topicId: result.topicId } : {}),
    ...("code" in result && result.code !== undefined ? { code: result.code } : {}),
    message: boundMessage(reason),
  };
  return {
    content: [{ type: "text", text: `Topic creation ${result.status}: ${details.message}` }],
    details,
  };
}

function readyResult(topic: TopicManifest): AgentToolResult<WorkTopicCreateToolDetails> {
  const details = { status: "ready", ...topicDetails(topic) };
  return {
    content: [
      {
        type: "text",
        text: `Topic ready. ID: ${topic.id}; Repository: ${topic.repository}; Branch: ${topic.branch}; Setup: ${topic.setup.state}; Worktree: ${topic.worktreePath ?? "unavailable"}.`,
      },
    ],
    details,
  };
}

function topicDetails(topic: TopicManifest): Omit<WorkTopicCreateToolDetails, "status"> {
  return {
    topicId: topic.id,
    repository: topic.repository,
    branch: topic.branch,
    setupState: topic.setup.state,
    worktreePath: topic.worktreePath,
  };
}

function confirmationResult(
  result: ConfirmationRequirement,
  resolved: ResolvedTopicCreationInput,
): AgentToolResult<WorkTopicCreateToolDetails> {
  return {
    content: [
      {
        type: "text",
        text: `Confirmation required from a direct human dialog: ${result.text}`,
      },
    ],
    details: {
      status: "confirmation-required",
      topicId: result.topicId,
      repository: resolved.repository,
      branch: resolved.branch,
      action: result.action,
      confirmationText: result.text,
    },
  };
}

function errorResult(error: unknown): AgentToolResult<WorkTopicCreateToolDetails> {
  const record = error !== null && typeof error === "object" ? error : undefined;
  const code =
    record !== undefined && "code" in record && typeof record.code === "string"
      ? record.code
      : "work-topic-create-failed";
  const rawMessage = error instanceof Error ? error.message : "Topic creation failed.";
  const detailsValue =
    record !== undefined &&
    "details" in record &&
    record.details !== null &&
    typeof record.details === "object"
      ? record.details
      : undefined;
  const existingTopicId = readBoundedString(detailsValue, "existingTopicId");
  const existingTopicName = readBoundedString(detailsValue, "existingTopicName");
  return failureResult(code, boundMessage(rawMessage), {
    ...(existingTopicId === undefined ? {} : { existingTopicId }),
    ...(existingTopicName === undefined ? {} : { existingTopicName }),
  });
}

function failureResult(
  code: string,
  message: string,
  extra: Partial<WorkTopicCreateToolDetails> = {},
): AgentToolResult<WorkTopicCreateToolDetails> {
  return {
    content: [{ type: "text", text: `Topic creation failed: ${boundMessage(message)}` }],
    details: { status: code === "cancelled" ? "cancelled" : "failed", code, message, ...extra },
  };
}

function readBoundedString(value: object | undefined, key: string): string | undefined {
  if (value === undefined || !(key in value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" ? boundMessage(item) : undefined;
}

class ToolCancelledError extends Error {}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ToolCancelledError("Topic creation was cancelled.");
}

async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (signal === undefined) return promise;
  throwIfAborted(signal);
  let abort = (): void => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => {
      onAbort?.();
      reject(new ToolCancelledError("Topic creation was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, cancellation]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
