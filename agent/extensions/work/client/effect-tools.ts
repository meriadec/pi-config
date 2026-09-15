import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { createWorkPaths } from "../shared/paths.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";

type TopicOperationPlan = Awaited<
  ReturnType<typeof import("./topic-operation.ts").planRootTopicOperation>
>;

const registeredApis = new WeakSet<object>();
const Common = {
  name: Type.String({
    description: "Required display name for the new Topic.",
    minLength: 1,
    maxLength: 200,
  }),
  branch: Type.Optional(
    Type.String({
      description: "Exact Worktree Branch. Omit it to derive a Git-safe Branch from the name.",
    }),
  ),
  sourceCheckout: Type.Optional(
    Type.String({
      description: "Checkout used for Git resolution. It defaults to the Pi working directory.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({
      description: "Maximum client wait in seconds. It does not cancel accepted daemon work.",
      minimum: 1,
      maximum: 3_600,
    }),
  ),
};
const RootParameters = Type.Object({
  ...Common,
  repository: Type.Optional(
    Type.String({ description: "Exact GitHub owner/repo. Omit it to infer from Source checkout." }),
  ),
  startPoint: Type.Optional(
    Type.String({
      description: "Local Git revision that the daemon resolves to one exact commit.",
    }),
  ),
});
const ChildParameters = Type.Object({
  ...Common,
  startPoint: Type.String({
    description: "Required revision on the exact Parent Topic Branch.",
    minLength: 1,
  }),
  parentTopicId: Type.Optional(
    Type.String({
      description: "Parent Topic ID. Omit it in a Parent Main Agent session.",
    }),
  ),
});

export interface EffectWorkToolsDependencies {
  readonly home?: string;
  readonly runtime?: string;
  readonly makeClient?: (socketPath: string) => WorkClientRuntime;
  readonly environment?: Record<string, string | undefined>;
}

/** Register both stable, focused LLM boundaries for durable Topic provisioning. */
export function registerEffectWorkTopicTools(
  pi: ExtensionAPI,
  dependencies: EffectWorkToolsDependencies = {},
): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);
  const paths = createWorkPaths({
    home: dependencies.home ?? homedir(),
    ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
  });
  const makeClient = async (): Promise<WorkClientRuntime> =>
    dependencies.makeClient === undefined
      ? (await import("./effect-runtime.ts")).makeWorkClientRuntime({ socketPath: paths.socket })
      : dependencies.makeClient(paths.socket);

  pi.registerTool({
    name: "work_topic_create",
    label: "Create Work Topic",
    description:
      "Create and provision one durable Work Topic through the same Effect operation as /work. The tool resolves repository, Branch, and Start Point before acceptance, waits by Operation Handle, and does not open a Main Agent.",
    promptSnippet: "Create and provision a durable Work Topic without opening its Main Agent",
    promptGuidelines: [
      "Use work_topic_create for an independent Topic. Use work_topic_create_child to continue an existing Topic from one of its commits.",
      "Omit optional arguments that the user did not specify. Never send blank repository, branch, startPoint, or sourceCheckout values.",
      "With an explicit repository and no Start Point, no Source checkout is needed. Otherwise Source checkout defaults to the Pi working directory.",
      "Set timeoutSeconds only for a user-requested wait deadline. Cancellation and timeout stop only this client wait.",
      "A confirmation-required result needs a separate direct human dialog. The original request is not approval, and this tool has no approval argument.",
    ],
    parameters: RootParameters,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      let client: WorkClientRuntime | undefined;
      let waiting = false;
      try {
        client = await makeClient();
        const { loadWorkConfiguration, planRootTopicOperation } =
          await import("./topic-operation.ts");
        const configuration = await loadWorkConfiguration(paths.config);
        const repository = blank(params.repository);
        const startPoint = blank(params.startPoint);
        const sourceCheckout = blank(params.sourceCheckout);
        const branch = blank(params.branch);
        const plan = await planRootTopicOperation(
          {
            name: params.name,
            ...(repository === undefined ? {} : { repository }),
            ...(branch === undefined ? {} : { branch }),
            ...(startPoint === undefined ? {} : { startPoint }),
            ...(repository !== undefined && startPoint === undefined
              ? {}
              : { sourceCheckout: sourceCheckout ?? ctx.cwd }),
          },
          configuration,
          client.clientId,
        );
        waiting = true;
        return await runToolOperation(client, plan, params.timeoutSeconds, signal, onUpdate, ctx);
      } catch (error) {
        if (!waiting) await client?.dispose();
        return toolError(error);
      }
    },
  });

  pi.registerTool({
    name: "work_topic_create_child",
    label: "Create Child Work Topic",
    description:
      "Create and provision one durable child Work Topic at an exact commit of its Parent Branch. It uses the same Effect operation as /work, waits by Operation Handle, and does not open a Main Agent.",
    promptSnippet: "Create a child Work Topic at an exact Parent Topic commit",
    promptGuidelines: [
      "Use git log to identify what startPoint does, then choose a short meaningful Topic name. Never invent a name from a SHA or commit position.",
      "Omit branch unless the user gave an exact Branch. Omit parentTopicId in a Parent Main Agent session.",
      "sourceCheckout defaults to the Pi working directory. The Start Point must be in the exact Parent Branch ancestry.",
      "A confirmation-required result needs a separate direct human dialog. This tool has no approval argument.",
      "Cancellation and timeout stop only this client wait; accepted daemon provisioning can continue.",
    ],
    parameters: ChildParameters,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      let client: WorkClientRuntime | undefined;
      let waiting = false;
      try {
        client = await makeClient();
        const { loadWorkConfiguration, planChildTopicOperation } =
          await import("./topic-operation.ts");
        const configuration = await loadWorkConfiguration(paths.config);
        const branch = blank(params.branch);
        const environment = dependencies.environment ?? process.env;
        const plan = await planChildTopicOperation(
          {
            name: params.name,
            startPoint: params.startPoint,
            parentTopicId: blank(params.parentTopicId) ?? environment["PI_WORK_TOPIC_ID"] ?? "",
            sourceCheckout: blank(params.sourceCheckout) ?? ctx.cwd,
            ...(branch === undefined ? {} : { branch }),
          },
          await client.snapshot(),
          configuration,
          client.clientId,
        );
        waiting = true;
        return await runToolOperation(client, plan, params.timeoutSeconds, signal, onUpdate, ctx);
      } catch (error) {
        if (!waiting) await client?.dispose();
        return toolError(error);
      }
    },
  });
}

async function runToolOperation(
  client: WorkClientRuntime,
  plan: TopicOperationPlan,
  timeoutSeconds: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate:
    | ((update: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void)
    | undefined,
  ctx: ExtensionContext,
) {
  onUpdate?.({
    content: [{ type: "text", text: "Starting durable Topic operation." }],
    details: { status: "running" },
  });
  const { startAndWaitForOperation } = await import("./operation-adapter.ts");
  const operation = await startAndWaitForOperation({
    client,
    request: plan.request,
    ...(signal === undefined ? {} : { signal }),
    context: ctx,
    ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1_000 }),
    onUpdate: (value) =>
      onUpdate?.({
        content: [{ type: "text", text: `Topic operation: ${value.phase}.` }],
        details: { status: value.state, operationId: value.id, phase: value.phase },
      }),
  });
  const status = semanticStatus(operation);
  const confirmationRequired = status === "confirmation-required";
  return {
    content: [
      {
        type: "text" as const,
        text: confirmationRequired
          ? `Confirmation required: ${operation.confirmationText} Operation: ${operation.id}.`
          : `Topic operation ${status}. Operation: ${operation.id}; Topic: ${plan.topicId}.`,
      },
    ],
    details: {
      status,
      operationId: operation.id,
      topicId: plan.topicId,
      repository: plan.repository,
      branch: plan.branch,
      phase: operation.phase,
      ...(operation.confirmationText === undefined
        ? {}
        : { confirmationText: operation.confirmationText }),
      ...(operation.result === undefined ? {} : { result: operation.result.value }),
    },
  };
}

function semanticStatus(operation: {
  state: string;
  phase: string;
  result?: { value: unknown } | undefined;
}): string {
  if (operation.state === "awaiting-confirmation") return "confirmation-required";
  const reason = resultReason(operation.result?.value);
  if (operation.phase === "rejected" || reason === "confirmation-rejected") return "rejected";
  if (reason === "denied") return "denied";
  return operation.state;
}

function resultReason(value: unknown): string | undefined {
  return typeof value === "object" && value !== null && "reason" in value
    ? String(value.reason)
    : undefined;
}

function toolError(error: unknown) {
  const waitReason = operationWaitReason(error);
  const cancelledBeforeAcceptance = error instanceof Error && error.name === "AbortError";
  const rawMessage = error instanceof Error ? error.message : "Topic operation failed.";
  const message = bound(rawMessage, 1_000);
  const code = failureString(error, "reason") ?? failureString(error, "code");
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status:
        waitReason ??
        (cancelledBeforeAcceptance ? "cancelled" : code === "denied" ? "denied" : "failed"),
      message,
      ...(code === undefined ? {} : { code: bound(code, 100) }),
      ...(operationWaitId(error) === undefined ? {} : { operationId: operationWaitId(error) }),
      ...publicFailureDetails(error),
    },
  };
}

function publicFailureDetails(error: unknown): Record<string, string> {
  if (typeof error !== "object" || error === null || !("details" in error)) return {};
  const details = error.details;
  if (typeof details !== "object" || details === null) return {};
  const record = details as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const key of ["operationId", "topicId", "existingTopicId", "existingTopicName"] as const) {
    const value = record[key];
    if (typeof value === "string") output[key] = bound(value, 200);
  }
  return output;
}

function failureString(error: unknown, key: "reason" | "code"): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function operationWaitReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "OperationWaitEnded") return undefined;
  return "reason" in error && typeof error.reason === "string" ? error.reason : undefined;
}

function operationWaitId(error: unknown): string | undefined {
  if (
    !(error instanceof Error) ||
    operationWaitReason(error) === undefined ||
    !("operationId" in error)
  ) {
    return undefined;
  }
  return typeof error.operationId === "string" ? error.operationId : undefined;
}

function bound(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 3)}...`;
}

function blank(value: string | undefined): string | undefined {
  const item = value?.trim();
  return item ? item : undefined;
}
