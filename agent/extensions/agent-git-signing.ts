import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { agentGitConfigGlobal } from "./lib/agent-git-config.ts";

export default function (pi: ExtensionAPI) {
  const agentGitConfig = agentGitConfigGlobal();

  const bashTool = createBashTool(process.cwd(), {
    spawnHook: ({ command, cwd, env }) => ({
      command,
      cwd,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: agentGitConfig,
      },
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (id, params, signal, onUpdate) => {
      return bashTool.execute(id, params, signal, onUpdate);
    },
  });
}
