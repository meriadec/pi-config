import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGrilladeSystemPromptAppendix } from "./prompts.ts";
import { registerGrilladeCommand } from "./session.ts";
import { registerGrilladeMockCommand } from "./ui/mock.ts";
import { reconstructGrilladeState } from "./state.ts";
import { registerGrilladeTools, setGrilladeToolsActive } from "./tools.ts";

export * from "./prompts.ts";
export * from "./protocol.ts";
export * from "./session.ts";
export * from "./state.ts";
export * from "./tools.ts";

export default function grilladeExtension(pi: ExtensionAPI): void {
  registerGrilladeCommand(pi);
  registerGrilladeMockCommand(pi);
  registerGrilladeTools(pi);
  pi.on("session_start", (_event, ctx) => {
    const state = reconstructGrilladeState(ctx.sessionManager);
    setGrilladeToolsActive(pi, state !== undefined && state.status !== "finished");
  });
  pi.on("before_agent_start", (event, ctx) => {
    const state = reconstructGrilladeState(ctx.sessionManager);
    const active = state !== undefined && state.status !== "finished";
    setGrilladeToolsActive(pi, active);
    if (!active) return undefined;
    return { systemPrompt: `${event.systemPrompt}${buildGrilladeSystemPromptAppendix(state)}` };
  });
}
