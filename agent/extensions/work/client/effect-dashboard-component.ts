import type { Component, TUI } from "@earendil-works/pi-tui";
import { copyTextToClipboard } from "../../shared/clipboard.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import {
  EffectDashboardRuntime,
  initialEffectDashboardState,
  type EffectDashboardState,
} from "./dashboard-runtime.ts";
import {
  handleDashboardViewInput,
  initialDashboardViewState,
  reconcileDashboardSelection,
  renderDashboardView,
  type DashboardAction,
  type DashboardViewState,
} from "./dashboard-view.ts";

export interface EffectWorkDashboardComponentOptions {
  readonly tui: TUI;
  readonly client: WorkClientRuntime;
  readonly done: () => void;
  readonly copyToClipboard?: (text: string) => Promise<void>;
}

/** TUI shell for the pure dashboard view and the Effect-owned dashboard driver. */
export class EffectWorkDashboardComponent implements Component {
  private effectState = initialEffectDashboardState();
  private viewState = initialDashboardViewState();
  private readonly runtime: EffectDashboardRuntime;
  private readonly options: EffectWorkDashboardComponentOptions;

  constructor(tui: TUI, client: WorkClientRuntime, done: () => void);
  constructor(options: EffectWorkDashboardComponentOptions);
  constructor(
    tuiOrOptions: TUI | EffectWorkDashboardComponentOptions,
    client?: WorkClientRuntime,
    done?: () => void,
  ) {
    this.options =
      "tui" in tuiOrOptions ? tuiOrOptions : { tui: tuiOrOptions, client: client!, done: done! };
    this.runtime = new EffectDashboardRuntime({
      client: this.options.client,
      onChange: (state) => {
        this.effectState = state;
        this.viewState = reconcileDashboardSelection(this.viewState, state.snapshot);
        this.options.tui.requestRender();
      },
    });
  }

  handleInput(data: string): void {
    if (
      data === "r" &&
      this.viewState.editor === undefined &&
      this.viewState.confirmation === undefined
    ) {
      void this.run("refresh", () => this.runtime.refresh());
      return;
    }
    const result = handleDashboardViewInput(this.viewState, this.effectState.snapshot, data);
    this.viewState = result.state;
    if (result.exit) {
      this.options.done();
      return;
    }
    if (result.action !== undefined) void this.execute(result.action);
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    return renderDashboardView(
      this.viewState,
      this.effectState.snapshot,
      width,
      this.options.tui.terminal.rows,
      this.effectState.message ?? phaseLabel(this.effectState),
    );
  }

  invalidate(): void {}

  dispose(): Promise<void> {
    return this.runtime.dispose();
  }

  snapshotViewState(): DashboardViewState {
    return this.viewState;
  }

  private async execute(action: DashboardAction): Promise<void> {
    const key = action.topicId;
    if (this.viewState.pending.has(key)) return;
    await this.run(key, async () => {
      switch (action._tag) {
        case "CopyBranch":
          await (this.options.copyToClipboard ?? copyTextToClipboard)(action.branch);
          this.setMessage("Branch name copied.");
          return;
        case "OpenWorkspace":
          this.setMessage(
            actionMessage(
              await this.options.client.ephemeralAction("workspace", action.topicId),
              "Topic workspace opened.",
            ),
          );
          return;
        case "OpenTerminal":
          this.setMessage(
            actionMessage(
              await this.options.client.ephemeralAction("terminal", action.topicId),
              "Terminal opened.",
            ),
          );
          return;
        case "OpenPullRequest":
          this.setMessage(
            actionMessage(
              await this.options.client.ephemeralAction("pull-request", action.topicId),
              "Pull request opened.",
            ),
          );
          return;
        case "OpenMainAgent":
          this.setMessage(
            actionMessage(
              await this.options.client.mainAgentCall({ action: "open", topicId: action.topicId }),
              "Main Agent opened.",
            ),
          );
          return;
        case "ResetMainAgent":
          this.setMessage(
            actionMessage(
              await this.options.client.mainAgentCall({ action: "reset", topicId: action.topicId }),
              "New Main Agent started.",
            ),
          );
          return;
        case "Rebase":
          await this.options.client.ephemeralAction("rebase", action.topicId);
          this.setMessage("Rebase finished.");
          return;
        case "Rename":
          await this.runtime.mutate(`rename:${action.topicId}`, {
            _tag: "Rename",
            topicId: action.topicId,
            name: action.name,
          });
          this.setMessage("Topic renamed.");
          return;
        case "SetNote":
          await this.runtime.mutate(`note:${action.topicId}`, {
            _tag: "SetNote",
            topicId: action.topicId,
            note: action.note,
          });
          this.setMessage(action.note.length === 0 ? "Topic Note removed." : "Topic Note saved.");
          return;
        case "MovePartition":
          await this.runtime.movePartition(action.topicId, action.direction);
          this.setMessage("Topic Partition moved.");
          return;
        case "Delete":
          await this.runtime.mutate(`delete:${action.topicId}`, {
            _tag: "Delete",
            topicId: action.topicId,
          });
          this.setMessage("Topic deleted.");
          return;
      }
    });
  }

  private async run(key: string, operation: () => Promise<unknown>): Promise<void> {
    this.setPending(key, true);
    try {
      await operation();
    } catch (error) {
      this.setMessage(error instanceof Error ? error.message : "The Work action failed.");
    } finally {
      this.setPending(key, false);
    }
  }

  private setPending(key: string, active: boolean): void {
    const pending = new Set(this.viewState.pending);
    if (active) pending.add(key);
    else pending.delete(key);
    this.viewState = { ...this.viewState, pending };
    this.options.tui.requestRender();
  }

  private setMessage(message: string): void {
    this.viewState = { ...this.viewState, message };
    this.options.tui.requestRender();
  }
}

function actionMessage(value: unknown, fallback: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  ) {
    return value.message;
  }
  return fallback;
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
