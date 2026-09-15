import { Key, matchesKey, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import {
  EffectDashboardRuntime,
  initialEffectDashboardState,
  type EffectDashboardState,
} from "./dashboard-runtime.ts";

/** Thin TUI shell for the Effect-owned dashboard driver. */
export class EffectWorkDashboardComponent implements Component {
  private state = initialEffectDashboardState();
  private readonly runtime: EffectDashboardRuntime;
  private readonly tui: TUI;
  private readonly done: () => void;

  constructor(tui: TUI, client: WorkClientRuntime, done: () => void) {
    this.tui = tui;
    this.done = done;
    this.runtime = new EffectDashboardRuntime({
      client,
      onChange: (state) => {
        this.state = state;
        this.tui.requestRender();
      },
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.done();
      return;
    }
    if (data === "r") void this.runtime.refresh();
  }

  render(width: number): string[] {
    const lines = ["Work — Effect control plane", ""];
    if (this.state.snapshot === undefined) {
      lines.push(this.state.message ?? phaseLabel(this.state));
    } else {
      lines.push(`Topics: ${this.state.snapshot.durable.topics.length}`);
      lines.push("");
      for (const { topic } of this.state.snapshot.durable.topics) {
        const observation = this.state.snapshot.observed.topics.find(
          (item) => item.topicId === topic.id,
        )?.value;
        lines.push(
          `${topic.partition + 1}. ${topic.name}  ${topic.repository}:${topic.branch}  ` +
            `${topic.setup.state}  ${observation?.mainAgentActivity ?? "stopped"}`,
        );
      }
    }
    lines.push("", "r refresh · q close");
    return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  invalidate(): void {}

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }
}

function phaseLabel(state: EffectDashboardState): string {
  switch (state.phase) {
    case "loading":
      return "Loading Work state…";
    case "reconnecting":
      return "Reconnecting to pi-workd…";
    case "failure":
      return "The Work dashboard could not connect.";
    case "connected":
      return "Work state is connected.";
  }
}
