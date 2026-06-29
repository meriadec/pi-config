import { homedir } from "node:os";
import { join } from "node:path";

export function agentGitConfigGlobal(): string {
  return process.env["PI_AGENT_GIT_CONFIG_GLOBAL"] ?? join(homedir(), ".gitconfig-agent");
}
