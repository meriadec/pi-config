import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// When Pi runs inside T3 Code, hide tools that duplicate or conflict with T3 features.
const HIDDEN_IN_T3 = new Set([
  "subagent",
  "work_topic_create",
  "work_topic_create_child",
  "work_topic_list",
  "work_topic_get",
  "work_topic_send_prompt",
  "ralph_issue_result",
]);

const insideT3 = () => Boolean(process.env["T3_MCP_URL"] || process.env["T3_PI_RUNTIME_MODE"]);

export default function (pi: ExtensionAPI) {
  if (!insideT3()) return;
  const apply = () => {
    const active = pi.getActiveTools();
    const kept = active.filter((n) => !HIDDEN_IN_T3.has(n));
    if (kept.length !== active.length) pi.setActiveTools(kept);
  };
  pi.on("session_start", apply);
  pi.on("before_agent_start", apply);
}
