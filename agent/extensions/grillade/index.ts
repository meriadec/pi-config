import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGrilladeSystemPromptAppendix } from "./prompts.ts";
import { registerGrilladeCommand } from "./session.ts";
import { registerGrilladeMockCommand } from "./ui/mock.ts";
import { reconstructGrilladeState } from "./state.ts";
import { registerGrilladeTools } from "./tools.ts";

export * from "./prompts.ts";
export * from "./protocol.ts";
export * from "./session.ts";
export * from "./state.ts";
export * from "./tools.ts";

export default function grilladeExtension(pi: ExtensionAPI): void {
  registerGrilladeCommand(pi);
  registerGrilladeMockCommand(pi);
  registerGrilladeTools(pi);
  pi.on("before_agent_start", (event, ctx) => {
    const state = reconstructGrilladeState(ctx.sessionManager);
    if (!state || state.status === "finished") return undefined;
    return { systemPrompt: `${event.systemPrompt}${buildGrilladeSystemPromptAppendix(state)}` };
  });
}
