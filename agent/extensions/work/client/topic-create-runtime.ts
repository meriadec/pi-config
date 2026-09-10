import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { WorkEvent } from "../daemon/protocol.ts";
import type { ConfirmationRequirement, TopicMutationResult } from "../daemon/topic-service.ts";
import { boundMessage } from "../shared/domain.ts";
import type { TopicManifest } from "../shared/domain.ts";

export const PROVISION_TIMEOUT_MS = 10 * 60_000;

/** The daemon client surface that every Topic-creation tool needs. */
export interface CreationConfirmationClient {
  confirm(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  reject(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  subscribe(handler: (event: WorkEvent) => void, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

/**
 * The identity a client can match in daemon events before the Topic id is known. A child
 * client knows only the Branch, because the repository comes from its Parent Topic.
 */
export interface CreationTarget {
  repository?: string;
  branch: string;
}

/** One resolved creation request, ready for the daemon. */
export interface CreationPlan<C extends CreationConfirmationClient> {
  target: CreationTarget;
  submit: (client: C, requestId: string, timeoutMs: number) => Promise<TopicMutationResult>;
}

export interface TopicCreationRunOptions<C extends CreationConfirmationClient> {
  ctx: ExtensionContext;
  requestId: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  onUpdate?: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined;
  resolve: () => Promise<CreationPlan<C>>;
  connect: () => Promise<C>;
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

/**
 * Runs one bounded creation request: resolve, connect, submit, follow Recipe progress,
 * and map every daemon outcome to bounded tool output. Cancellation never leaves the
 * daemon connection open, and a confirmation requirement always returns to the caller.
 */
export async function runTopicCreation<C extends CreationConfirmationClient>(
  options: TopicCreationRunOptions<C>,
): Promise<AgentToolResult<WorkTopicCreateToolDetails>> {
  const { ctx, requestId, timeoutMs, signal } = options;
  let client: C | undefined;
  let currentPhase = "start";
  let requestSent = false;
  const reportProgress = progressReporter(options.onUpdate);
  const progress = (phase: string, text: string): void => {
    currentPhase = phase;
    reportProgress(phase, text);
  };

  try {
    throwIfAborted(signal);
    progress("resolve", "Resolving Topic input.");
    const plan = await abortable(options.resolve(), signal);

    progress("connect", "Connecting to the work daemon.");
    const connecting = options.connect();
    if (signal !== undefined) {
      void connecting
        .then((connected) => {
          if (signal.aborted) connected.close();
        })
        .catch(() => undefined);
    }
    client = await abortable(connecting, signal);

    const reportDaemonEvent = daemonProgressReporter(plan.target, progress);
    await abortable(client.subscribe(reportDaemonEvent, 2_000), signal, () => client?.close());
    progress("provision", "Provisioning the Topic.");
    requestSent = true;
    let result = await abortable(plan.submit(client, requestId, timeoutMs), signal, () =>
      client?.close(),
    );

    let confirmationIndex = 0;
    while (result.status === "confirmation-required") {
      if (!ctx.hasUI) return confirmationResult(result, plan.target);
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
    if (result.status === "confirmation-required") return confirmationResult(result, plan.target);

    return mutationResult(result, plan.target);
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

function daemonProgressReporter(
  target: CreationTarget,
  report: (phase: string, text: string) => void,
): (event: WorkEvent) => void {
  let topicId: string | undefined;
  return (event) => {
    if (event.type === "topic-added") {
      const sameRepository =
        target.repository === undefined || event.topic.repository === target.repository;
      if (!sameRepository || event.topic.branch !== target.branch) return;
      topicId = event.topic.id;
      report("clone", "Preparing the repository clone.");
      return;
    }
    if (topicId === undefined) return;
    if (event.type === "operation-changed") {
      if (event.topicId !== topicId || !event.operation?.detail?.startsWith("setup ")) return;
      report(event.operation.detail, `${event.operation.detail}.`);
      return;
    }
    if (
      (event.type === "setup-changed" || event.type === "topic-changed") &&
      event.topic.id === topicId &&
      event.topic.setup.worktreeCreated
    ) {
      report("worktree", "Created the Topic Worktree.");
    }
  };
}

function mutationResult(
  result: Exclude<TopicMutationResult, ConfirmationRequirement>,
  target: CreationTarget,
): AgentToolResult<WorkTopicCreateToolDetails> {
  if (result.status === "ready") return readyResult(result.topic);
  const topic = "topic" in result ? result.topic : undefined;
  const reason = "reason" in result ? result.reason : `Topic creation ${result.status}.`;
  const details: WorkTopicCreateToolDetails = {
    status: result.status,
    ...(topic === undefined ? {} : topicDetails(topic)),
    ...(topic === undefined ? targetDetails(target) : {}),
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

function targetDetails(target: CreationTarget): Omit<WorkTopicCreateToolDetails, "status"> {
  return {
    ...(target.repository === undefined ? {} : { repository: target.repository }),
    branch: target.branch,
  };
}

function confirmationResult(
  result: ConfirmationRequirement,
  target: CreationTarget,
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
      ...targetDetails(target),
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
