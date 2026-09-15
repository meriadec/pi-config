import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { createWorkPaths } from "../shared/paths.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";

type TopicOperationPlan = Awaited<
  ReturnType<typeof import("./topic-operation.ts").planRootTopicOperation>
>;

const Common = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  branch: Type.Optional(Type.String()),
  sourceCheckout: Type.Optional(Type.String()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3_600 })),
};
const RootParameters = Type.Object({
  ...Common,
  repository: Type.Optional(Type.String()),
  startPoint: Type.Optional(Type.String()),
});
const ChildParameters = Type.Object({
  ...Common,
  startPoint: Type.String({ minLength: 1 }),
  parentTopicId: Type.Optional(Type.String()),
});

export interface EffectWorkToolsDependencies {
  readonly home?: string;
  readonly runtime?: string;
  readonly makeClient?: (socketPath: string) => WorkClientRuntime;
  readonly environment?: Record<string, string | undefined>;
}

/** Register production-independent Operation Handle versions of both stable Pi tool names. */
export function registerEffectWorkTopicTools(
  pi: ExtensionAPI,
  dependencies: EffectWorkToolsDependencies = {},
): void {
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
    description: "Create and provision one durable Work Topic, then wait by Operation Handle.",
    parameters: RootParameters,
    execute: async (_id, params, signal, onUpdate, ctx) => {
      const client = await makeClient();
      try {
        const { loadWorkConfiguration, planRootTopicOperation } =
          await import("./topic-operation.ts");
        const configuration = await loadWorkConfiguration(paths.config);
        const explicitRepository = blank(params.repository);
        const startPoint = blank(params.startPoint);
        const sourceCheckout = blank(params.sourceCheckout);
        const plan = await planRootTopicOperation(
          {
            name: params.name,
            ...(explicitRepository === undefined ? {} : { repository: explicitRepository }),
            ...(blank(params.branch) === undefined ? {} : { branch: blank(params.branch)! }),
            ...(startPoint === undefined ? {} : { startPoint }),
            ...(explicitRepository !== undefined && startPoint === undefined
              ? {}
              : { sourceCheckout: sourceCheckout ?? ctx.cwd }),
          },
          configuration,
          client.clientId,
        );
        return await runToolOperation(client, plan, params.timeoutSeconds, signal, onUpdate, ctx);
      } catch (error) {
        await client.dispose();
        return toolError(error);
      }
    },
  });
  pi.registerTool({
    name: "work_topic_create_child",
    label: "Create Child Work Topic",
    description: "Create and provision one child Work Topic, then wait by Operation Handle.",
    parameters: ChildParameters,
    execute: async (_id, params, signal, onUpdate, ctx) => {
      const client = await makeClient();
      try {
        const { loadWorkConfiguration, planChildTopicOperation } =
          await import("./topic-operation.ts");
        const configuration = await loadWorkConfiguration(paths.config);
        const plan = await planChildTopicOperation(
          {
            name: params.name,
            startPoint: params.startPoint,
            parentTopicId:
              blank(params.parentTopicId) ?? dependencies.environment?.["PI_WORK_TOPIC_ID"] ?? "",
            sourceCheckout: blank(params.sourceCheckout) ?? ctx.cwd,
            ...(blank(params.branch) === undefined ? {} : { branch: blank(params.branch)! }),
          },
          await client.snapshot(),
          configuration,
          client.clientId,
        );
        return await runToolOperation(client, plan, params.timeoutSeconds, signal, onUpdate, ctx);
      } catch (error) {
        await client.dispose();
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
  const confirmationRequired = operation.state === "awaiting-confirmation";
  return {
    content: [
      {
        type: "text" as const,
        text: confirmationRequired
          ? `Confirmation required from a direct human dialog. Operation: ${operation.id}.`
          : `Topic operation ${operation.state}. Operation: ${operation.id}; Topic: ${plan.topicId}.`,
      },
    ],
    details: {
      status: confirmationRequired ? "confirmation-required" : operation.state,
      operationId: operation.id,
      topicId: plan.topicId,
      repository: plan.repository,
      branch: plan.branch,
    },
  };
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : "Topic operation failed.";
  return {
    content: [{ type: "text" as const, text: message }],
    details: {
      status: operationWaitReason(error) ?? "failed",
      message,
      ...(operationWaitId(error) === undefined ? {} : { operationId: operationWaitId(error) }),
    },
  };
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

function blank(value: string | undefined): string | undefined {
  const item = value?.trim();
  return item ? item : undefined;
}
