import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWorkCommand } from "./command.ts";

describe("/work command", () => {
  test("registers once and guards custom UI outside TUI mode", async () => {
    const commands: Array<{
      name: string;
      options: { handler: (args: string, ctx: any) => Promise<void> };
    }> = [];
    const events: Array<{ name: string; handler: () => void }> = [];
    const pi = {
      registerCommand(
        name: string,
        options: { handler: (args: string, ctx: any) => Promise<void> },
      ) {
        commands.push({ name, options });
      },
      on(name: string, handler: () => void) {
        events.push({ name, handler });
      },
    } as unknown as ExtensionAPI;
    let setupCalls = 0;
    registerWorkCommand(pi, {
      setup: async () => {
        setupCalls += 1;
        return undefined;
      },
    });
    registerWorkCommand(pi);

    expect(commands.map((command) => command.name)).toEqual(["work"]);
    expect(events.map((event) => event.name)).toEqual(["session_shutdown"]);
    const notices: string[] = [];
    let customCalls = 0;
    await commands[0]!.options.handler("", {
      mode: "print",
      ui: {
        notify: (message: string) => notices.push(message),
        custom: async () => {
          customCalls += 1;
        },
      },
    });
    expect(notices).toEqual(["/work requires interactive TUI mode."]);
    expect(customCalls).toBe(0);
    expect(setupCalls).toBe(0);
  });
});
