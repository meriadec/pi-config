import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkCommand } from "./client/command.ts";
import { registerWorkTopicCreateTool } from "./client/topic-create-tool.ts";
import { registerTopicAgentTelemetry } from "./topic-agent/reporter.ts";

export * from "./client/dashboard.ts";
export * from "./client/setup.ts";
export * from "./client/topic-creation.ts";
export * from "./client/topic-create-tool.ts";

export default function workExtension(pi: ExtensionAPI): void {
  registerWorkCommand(pi);
  registerWorkTopicCreateTool(pi);
  registerTopicAgentTelemetry(pi);
}
