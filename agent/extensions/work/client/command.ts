import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SystemdWorkdManager, defaultSystemdPaths } from "./systemd.ts";
import { WorkDashboardComponent, type DashboardClient } from "./dashboard-component.ts";
import { completeWorkBaseSetup } from "./setup.ts";
import { createConfigStore, createWorkPaths } from "../shared/index.ts";

export interface WorkCommandDependencies {
  home?: string;
  runtime?: string;
  connect?: () => Promise<DashboardClient>;
  setup?: typeof completeWorkBaseSetup;
}

const registeredApis = new WeakSet<object>();

export function registerWorkCommand(
  pi: ExtensionAPI,
  dependencies: WorkCommandDependencies = {},
): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);
  const active = new Set<WorkDashboardComponent>();

  pi.registerCommand("work", {
    description: "Open the full-screen Topic control plane",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/work requires interactive TUI mode.", "error");
        return;
      }

      let paths;
      try {
        paths = createWorkPaths({
          home: dependencies.home ?? homedir(),
          ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
        });
        const configured = await (dependencies.setup ?? completeWorkBaseSetup)(
          createConfigStore(paths),
          {
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            notify: (message, level) => ctx.ui.notify(message, level),
          },
          dependencies.home === undefined ? {} : { home: dependencies.home },
        );
        if (configured === undefined) return;
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "Could not configure WORK_BASE.",
          "error",
        );
        return;
      }

      const dashboardClientId = randomUUID();
      const connect =
        dependencies.connect ??
        (() =>
          new SystemdWorkdManager({
            paths: defaultSystemdPaths(dependencies.home ?? homedir(), paths.socket),
            clientId: dashboardClientId,
          }).ensureConnected());
      let component: WorkDashboardComponent | undefined;
      try {
        await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
          component = new WorkDashboardComponent({ tui, connect, done });
          active.add(component);
          return component;
        });
      } finally {
        if (component !== undefined) {
          active.delete(component);
          component.dispose();
        }
      }
    },
  });

  pi.on("session_shutdown", () => {
    for (const component of active) component.dispose();
    active.clear();
  });
}
