import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
	const agentGitConfig = process.env["PI_AGENT_GIT_CONFIG_GLOBAL"] ?? join(homedir(), ".gitconfig-agent");

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
