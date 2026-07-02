import { contextPath, requestPath, resultPath, statusPath } from "./mailbox.ts";

export function buildChildSystemPrompt(jobId: string, jobDir: string): string {
  return `\n\n# Delegation Job ${jobId}\n\nYou are running as a Pi sub-agent for a parent Pi session. You may have been started from a fork of the parent conversation, or with a fresh minimal context. The context packet in \`${contextPath(jobDir)}\` records which mode was used.\n\nYour durable job inputs are:\n\n- The task prompt in \`${requestPath(jobDir)}\`\n- The context packet in \`${contextPath(jobDir)}\`\n- Normal project-local Pi context loaded by this child session\n\nDo not spawn more sub-agents. Recursive delegation is intentionally disabled; keep all delegated work inside this child session.\n\nWork independently in this child session. It is okay to inspect files and run commands here, but do not paste raw command output into your final answer unless it is essential.\n\nWhen you have a satisfying terminal result, call the \`sub_done\` tool with a concise Markdown result for the parent. Treat \`sub_done\` as your final action: after calling it, do not write a separate final answer, recap, or summary in this child session. The parent session will import only that Delegation Result from \`${resultPath(jobDir)}\`, not your transcript or intermediate tool outputs.\n\nDo **not** call \`sub_done\` for intermediate human-in-the-loop states. If the active skill or task requires confirmation, clarification, credentials, branch selection, PR approval, or any other human decision, ask that question inside this child session and wait for the human here. Only call \`sub_done\` after the delegated work is completed, explicitly skipped/canceled by the human, or genuinely blocked after exhausting what can be resolved inside the child session.\n\nA good Delegation Result includes:\n\n- The terminal outcome, not an intermediate confirmation request\n- The direct answer or recommendation\n- Key evidence and file paths when relevant\n- Any caveats or follow-up actions\n\nKeep the result compact. Do not include exhaustive logs, command transcripts, or unrelated exploration notes.\n\nIf a human manually finishes the child session, they can also type \`/sub-done\` to write the result. Status is tracked in \`${statusPath(jobDir)}\`.\n`;
}

export function buildInitialChildPrompt(jobId: string, prompt: string, jobDir: string): string {
  return `Delegation Job ${jobId}\n\nTask:\n${prompt}\n\nUse the bounded context packet at ${contextPath(jobDir)} if useful. Ask any needed human-in-the-loop questions inside this child session. When the delegated work reaches a terminal outcome, call sub_done with the compact Delegation Result for the parent session.`;
}

export interface ParentLaunchMessageOptions {
  prompt: string;
  handoffMode: "fresh" | "fork";
  skillName?: string;
}

export function buildParentLaunchMessage(
  jobId: string,
  options: ParentLaunchMessageOptions,
): string {
  const mode =
    options.handoffMode === "fork" ? "forked from parent conversation" : "fresh minimal context";

  if (!options.skillName) {
    return `Launched sub-agent Delegation Job ${jobId}.\n\nMode: ${mode}\nPrompt:\n\n${options.prompt}`;
  }

  const prompt = options.prompt.trim() || "(none)";
  return `Launched skill sub-agent Delegation Job ${jobId}.\n\nSkill: ${options.skillName}\nMode: ${mode}\nPrompt:\n\n${prompt}`;
}

export function buildParentFollowUp(jobId: string, result: string): string {
  return `Sub-agent Delegation Job ${jobId} completed.\n\nDelegation Result:\n\n${result}\n\nPlease summarize this Delegation Result for the human, then raise human-in-the-loop by asking how they want to proceed. Do not implement recommended fixes, edit files, run commands, create commits, or otherwise act on the result unless the human explicitly approves that follow-up work in a later message.`;
}

export function buildChildCompletionMessage(jobId: string, result: string): string {
  return `Delegation Result written for ${jobId}. Stop now; do not add a separate summary in this child session.\n\nResult:\n\n${result}`;
}
