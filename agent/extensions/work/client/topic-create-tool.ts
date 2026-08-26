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

const PROVISION_TIMEOUT_MS = 10 * 60_000;
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

export interface WorkTopicCreateInput extends TopicCreationInput {
  timeoutSeconds?: number;
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
    ],
    parameters: WorkTopicCreateParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWorkTopicCreate(toolCallId, params, signal, onUpdate, ctx, dependencies);
    },
  });
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

function nonBlank(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

async function executeWorkTopicCreate(
  toolCallId: string,
  params: WorkTopicCreateInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
  ctx: ExtensionContext,
  dependencies: WorkTopicCreateToolDependencies,
): Promise<AgentToolResult<WorkTopicCreateToolDetails>> {
  let client: TopicCreateToolClient | undefined;
  let currentPhase = "start";
  let requestSent = false;
  const requestId = dependencies.requestId?.() ?? `${toolCallId}:${randomUUID()}`;
  const timeoutMs =
    dependencies.timeoutMs ??
    (params.timeoutSeconds === undefined ? PROVISION_TIMEOUT_MS : params.timeoutSeconds * 1_000);
  const reportProgress = progressReporter(onUpdate);
  const progress = (phase: string, text: string): void => {
    currentPhase = phase;
    reportProgress(phase, text);
  };

  try {
    throwIfAborted(signal);
    progress("resolve", "Resolving Topic input.");
    const normalized = normalizeTopicCreationInput(params);
    const resolved = await abortable(
      (dependencies.resolveInput ?? resolveTopicCreationInput)({
        ...normalized,
        sourceCheckout: normalized.sourceCheckout ?? ctx.cwd,
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
    requestSent = true;
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
      return toolCancellationResult(currentPhase, requestSent);
    }
    return errorResult(error, currentPhase);
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

function errorResult(error: unknown, phase: string): AgentToolResult<WorkTopicCreateToolDetails> {
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
    phase,
    ...(existingTopicId === undefined ? {} : { existingTopicId }),
    ...(existingTopicName === undefined ? {} : { existingTopicName }),
  });
}

function toolCancellationResult(
  phase: string,
  requestSent: boolean,
): AgentToolResult<WorkTopicCreateToolDetails> {
  const nextStep = requestSent
    ? "Topic provisioning can continue in the work daemon. Check /work for the current Topic state before you retry with the same repository and Branch."
    : "No Topic request was sent. Retry the tool call.";
  const message = `The tool call was cancelled during ${phase}. ${nextStep}`;
  return {
    content: [{ type: "text", text: boundMessage(message) }],
    details: {
      status: "cancelled",
      code: "tool-call-cancelled",
      message: boundMessage(message),
      phase,
    },
  };
}

function failureResult(
  code: string,
  message: string,
  extra: Partial<WorkTopicCreateToolDetails> = {},
): AgentToolResult<WorkTopicCreateToolDetails> {
  const status =
    code === "cancelled" ? "cancelled" : code === "request-timeout" ? "timeout" : "failed";
  return {
    content: [
      {
        type: "text",
        text: `Topic creation ${status === "timeout" ? "timed out" : "failed"}: ${boundMessage(message)}`,
      },
    ],
    details: { status, code, message, ...extra },
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
