import { randomUUID } from "node:crypto";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TopicMutationResult } from "../daemon/topic-service.ts";
import {
  runTopicCreation,
  type CreationConfirmationClient,
  type WorkTopicCreateToolDetails,
} from "./topic-create-runtime.ts";
import { connectWorkDaemon, creationTimeoutMs, nonBlank } from "./topic-create-tool.ts";
import {
  resolveChildTopicCreationInput,
  type ChildTopicCreationInput,
  type ResolvedChildTopicCreationInput,
} from "./topic-creation.ts";

const registeredApis = new WeakSet<object>();

const WorkTopicCreateChildParameters = Type.Object({
  name: Type.String({
    description: "Required display name for the new child Topic.",
    minLength: 1,
    maxLength: 200,
  }),
  startPoint: Type.String({
    description:
      "Required local Git revision on the Parent Topic Branch, such as a SHA, HEAD~2, or a tag, at which the child Topic starts.",
    minLength: 1,
  }),
  parentTopicId: Type.Optional(
    Type.String({
      description:
        "Parent Topic ID. Omit it inside a Parent Main Agent, where the session supplies the Parent Topic.",
    }),
  ),
  branch: Type.Optional(
    Type.String({
      description:
        "Branch for the child Worktree. Omit it to make a Git-safe Branch from the Topic name.",
    }),
  ),
  sourceCheckout: Type.Optional(
    Type.String({
      description:
        "Local Git checkout used to resolve the Start Point. Defaults to the Pi working directory.",
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

export interface ChildTopicCreateToolClient extends CreationConfirmationClient {
  createChildTopic(
    input: ResolvedChildTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
}

export interface WorkTopicCreateChildToolDependencies {
  home?: string;
  runtime?: string;
  timeoutMs?: number;
  environment?: Record<string, string | undefined>;
  resolveInput?: typeof resolveChildTopicCreationInput;
  connect?: () => Promise<ChildTopicCreateToolClient>;
  requestId?: () => string;
}

export interface WorkTopicCreateChildInput extends ChildTopicCreationInput {
  timeoutSeconds?: number;
}

/** Register the focused LLM boundary for child Topic creation on a Parent Topic commit. */
export function registerWorkTopicCreateChildTool(
  pi: ExtensionAPI,
  dependencies: WorkTopicCreateChildToolDependencies = {},
): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);

  pi.registerTool({
    name: "work_topic_create_child",
    label: "Create Child Work Topic",
    description:
      "Create and provision one child work Topic that starts at an exact commit of a Parent Topic Branch, through the same daemon operation as the /work UI. Use it for requests such as ‘Create a child Topic for the first commit’ or ‘Continue this Topic from commit abc1234.’ It waits for provisioning and does not open the child Topic's Main Agent.",
    promptSnippet: "Create and provision a child work Topic at an exact Parent Topic commit",
    promptGuidelines: [
      "Use work_topic_create_child when the new Topic must continue an existing Topic from one of its commits; use work_topic_create for an independent Topic.",
      "startPoint is required and must name one commit of the Parent Topic Branch. Inspect the commit with git log before you call the tool, so the name matches the real change.",
      "Choose a short, meaningful Topic name from what the commit does. Never invent a name from a SHA or from a commit position such as ‘first commit’.",
      "Omit branch unless the user stated an exact Branch name; the daemon then derives the Branch from the Topic name.",
      "Omit parentTopicId inside a Parent Main Agent; supply it only when the session has no Parent Topic.",
      "sourceCheckout is the local checkout used to resolve startPoint; omit it to use the current Pi working directory.",
      "Set timeoutSeconds only when the user asks for a specific wait timeout; otherwise omit it to use 600 seconds.",
      "A daemon confirmation-required result always needs a separate direct human dialog. This tool has no approval parameter.",
    ],
    parameters: WorkTopicCreateChildParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return executeWorkTopicCreateChild(toolCallId, params, signal, onUpdate, ctx, dependencies);
    },
  });
}

async function executeWorkTopicCreateChild(
  _toolCallId: string,
  params: WorkTopicCreateChildInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<WorkTopicCreateToolDetails> | undefined,
  ctx: ExtensionContext,
  dependencies: WorkTopicCreateChildToolDependencies,
): Promise<AgentToolResult<WorkTopicCreateToolDetails>> {
  return runTopicCreation<ChildTopicCreateToolClient>({
    ctx,
    signal,
    onUpdate,
    requestId: dependencies.requestId?.() ?? randomUUID(),
    timeoutMs: creationTimeoutMs(dependencies.timeoutMs, params.timeoutSeconds),
    resolve: async () => {
      const branch = nonBlank(params.branch);
      const parentTopicId = nonBlank(params.parentTopicId);
      const resolved = await (dependencies.resolveInput ?? resolveChildTopicCreationInput)(
        {
          name: params.name,
          startPoint: params.startPoint,
          ...(branch === undefined ? {} : { branch }),
          ...(parentTopicId === undefined ? {} : { parentTopicId }),
          sourceCheckout: nonBlank(params.sourceCheckout) ?? ctx.cwd,
        },
        dependencies.environment === undefined ? {} : { environment: dependencies.environment },
      );
      return {
        target: { branch: resolved.branch },
        submit: (client, requestId, timeoutMs) =>
          client.createChildTopic(resolved, requestId, timeoutMs),
      };
    },
    connect: () =>
      dependencies.connect?.() ?? connectWorkDaemon(dependencies.home, dependencies.runtime),
  });
}
