import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWorkPaths } from "../shared/paths.ts";
import type { EffectWorkDashboardComponent } from "./effect-dashboard-component.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import type { completeWorkBaseSetup } from "./work-base-setup.ts";

export interface EffectWorkCommandDependencies {
  readonly home?: string;
  readonly runtime?: string;
  readonly connect?: () => Promise<WorkClientRuntime>;
  readonly setup?: typeof completeWorkBaseSetup;
}

const registeredApis = new WeakSet<object>();

/** Registers `/work` without constructing the Work runtime in an ordinary Pi session. */
export function registerEffectWorkCommand(
  pi: ExtensionAPI,
  dependencies: EffectWorkCommandDependencies = {},
): void {
  if (registeredApis.has(pi)) return;
  registeredApis.add(pi);
  const active = new Set<EffectWorkDashboardComponent>();

  pi.registerCommand("work", {
    description: "Open the full-screen Topic control plane",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/work requires interactive TUI mode.", "error");
        return;
      }
      try {
        const home = dependencies.home ?? homedir();
        const paths = createWorkPaths({
          home,
          ...(dependencies.runtime === undefined ? {} : { runtime: dependencies.runtime }),
        });
        const setup =
          dependencies.setup ?? (await import("./work-base-setup.ts")).completeWorkBaseSetup;
        const configured = await setup(
          paths.config,
          {
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
            notify: (message, level) => ctx.ui.notify(message, level),
          },
          dependencies.home === undefined ? {} : { home: dependencies.home },
        );
        if (configured === undefined) return;

        const client =
          dependencies.connect === undefined
            ? await (async () => {
                const [{ makeWorkClientRuntime }, { defaultSystemdPaths, SystemdWorkdManager }] =
                  await Promise.all([import("./effect-runtime.ts"), import("./systemd.ts")]);
                return new SystemdWorkdManager<WorkClientRuntime>({
                  paths: defaultSystemdPaths(home, paths.socket),
                  connect: async (socketPath) => makeWorkClientRuntime({ socketPath }),
                }).ensureConnected();
              })()
            : await dependencies.connect();
        let component: EffectWorkDashboardComponent | undefined;
        try {
          const { EffectWorkDashboardComponent } = await import("./effect-dashboard-component.ts");
          await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
            component = new EffectWorkDashboardComponent({
              tui,
              client,
              done,
              configuration: configured,
            });
            active.add(component);
            return component;
          });
        } finally {
          if (component !== undefined) {
            active.delete(component);
            await component.dispose();
          } else {
            await client.dispose();
          }
        }
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : "The Work dashboard could not open.",
          "error",
        );
      }
    },
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([...active].map((component) => component.dispose()));
    active.clear();
  });
}
