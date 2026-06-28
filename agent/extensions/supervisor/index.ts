import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GitHubClient } from "./github.ts";
import { SupervisorComponent } from "./ui.ts";

export default function supervisorExtension(pi: ExtensionAPI) {
  pi.registerCommand("supervisor", {
    description: "Open the fullscreen GitHub notification supervisor",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/supervisor requires interactive TUI mode", "error");
        return;
      }

      const github = new GitHubClient(pi.exec.bind(pi));
      let component: SupervisorComponent | undefined;

      try {
        await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
          component = new SupervisorComponent(tui, theme, github, pi.exec.bind(pi), done);
          return component;
        });
      } finally {
        component?.dispose();
      }
    },
  });
}
