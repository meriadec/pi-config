import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerEffectWorkCommand } from "./client/effect-command.ts";
import { registerEffectWorkTopicTools } from "./client/effect-tools.ts";
import { registerEffectTopicAgentTelemetry } from "./topic-agent/effect-reporter.ts";

// Keep the auto-discovered entry small. Runtime modules load only when a command, tool,
// or valid Topic Agent session needs them.

export default function workExtension(pi: ExtensionAPI): void {
  registerEffectWorkCommand(pi);
  registerEffectWorkTopicTools(pi);
  registerEffectTopicAgentTelemetry(pi);
}
