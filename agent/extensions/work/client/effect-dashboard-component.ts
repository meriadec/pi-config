import { Key, matchesKey, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { copyTextToClipboard } from "../../shared/clipboard.ts";
import type { OperationId } from "../domain/index.ts";
import type { WorkConfiguration } from "../infrastructure/config.ts";
import type { WorkClientRuntime } from "./effect-runtime.ts";
import {
  planChildTopicOperation,
  planRootTopicOperation,
  planRetryTopicOperation,
  type TopicOperationPlan,
} from "./topic-operation.ts";
import { DEFAULT_CLIENT_WAIT_MS, waitForOperationDeadline } from "./operation-adapter.ts";
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
  selectionAfterTopicDeletion,
  updateDashboardEditorValue,
  type DashboardAction,
  type DashboardViewState,
  type SensitiveActionKind,
} from "./dashboard-view.ts";
import {
  handleChildTopicWizardInput,
  initialChildTopicWizardState,
  renderChildTopicWizard,
  updateChildTopicWizardField,
  type ChildTopicWizardState,
  type ChildTopicWizardSubmit,
} from "./child-topic-wizard.ts";
import { StandardTextEntry } from "./standard-text-entry.ts";
import {
  completeRootRepository,
  handleRootTopicWizardInput,
  initialRootTopicWizardState,
  moveRootRepositoryHighlight,
  renderRootTopicWizard,
  updateRootTopicWizardField,
  type RootTopicWizardState,
} from "./root-topic-wizard.ts";

export interface EffectWorkDashboardComponentOptions {
  readonly tui: TUI;
  readonly client: WorkClientRuntime;
  readonly done: () => void;
  readonly copyToClipboard?: (text: string) => Promise<void>;
  readonly configuration?: WorkConfiguration;
}

/** TUI shell for the pure dashboard view and the Effect-owned dashboard driver. */
export class EffectWorkDashboardComponent implements Component, Focusable {
  private effectState = initialEffectDashboardState();
  private viewState = initialDashboardViewState();
  private textEntry: StandardTextEntry | undefined;
  private textEntryKey: string | undefined;
  private rootWizard: RootTopicWizardState | undefined;
  private rootWizardEntry: StandardTextEntry | undefined;
  private rootWizardEntryStage: string | undefined;
  private rootOperation: { readonly id: OperationId; readonly confirmation?: string } | undefined;
  private rootPlan: TopicOperationPlan | undefined;
  private acceptedRootTopicId: DashboardViewState["selectedTopicId"];
  private childWizard: ChildTopicWizardState | undefined;
  private childWizardEntry: StandardTextEntry | undefined;
  private childWizardEntryStage: string | undefined;
  private childPlan: TopicOperationPlan | undefined;
  private readonly retryPlans = new Map<DashboardAction["topicId"], TopicOperationPlan>();
  private childWaitAbort: AbortController | undefined;
  private stopChildWatch: (() => void) | undefined;
  private childSubmissionSerial = 0;
  private _focused = false;
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
    this.viewState = {
      ...this.viewState,
      creationAvailable: this.options.configuration !== undefined,
    };
    this.runtime = new EffectDashboardRuntime({
      client: this.options.client,
      onChange: (state) => {
        this.effectState = state;
        this.viewState = {
          ...reconcileDashboardSelection(this.viewState, state.snapshot),
          shimmerPhase: state.shimmerPhase,
        };
        this.selectAcceptedRootTopic();
        this.options.tui.requestRender();
      },
    });
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.textEntry !== undefined) this.textEntry.focused = value;
    if (this.rootWizardEntry !== undefined) this.rootWizardEntry.focused = value;
    if (this.childWizardEntry !== undefined) this.childWizardEntry.focused = value;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      this.options.done();
      return;
    }
    if (this.childWizard !== undefined) {
      this.handleChildWizardInput(data);
      return;
    }
    if (this.rootWizard !== undefined) {
      this.handleRootWizardInput(data);
      return;
    }
    if (
      (data === "a" || data === "A") &&
      !this.viewState.pending.has("create") &&
      this.viewState.editor === undefined &&
      this.viewState.confirmation === undefined &&
      this.options.configuration !== undefined
    ) {
      this.rootWizard = initialRootTopicWizardState();
      this.syncRootWizardEntry();
      this.options.tui.requestRender();
      return;
    }
    if (
      data === "r" &&
      this.viewState.editor === undefined &&
      this.viewState.confirmation === undefined
    ) {
      void this.run("refresh", async () => {
        await this.runtime.refresh();
        this.setMessage("Local repository state refreshed; pull requests are updating.");
      });
      return;
    }
    if (
      this.viewState.editor !== undefined &&
      !matchesKey(data, Key.enter) &&
      !matchesKey(data, Key.escape)
    ) {
      this.syncTextEntry();
      this.textEntry?.handleInput(data);
      if (this.textEntry !== undefined) {
        this.viewState = updateDashboardEditorValue(this.viewState, this.textEntry.getValue());
      }
      this.options.tui.requestRender();
      return;
    }
    if (this.viewState.editor !== undefined && this.textEntry !== undefined) {
      this.viewState = updateDashboardEditorValue(this.viewState, this.textEntry.getValue());
    }
    const result = handleDashboardViewInput(this.viewState, this.effectState.snapshot, data);
    this.viewState = result.state;
    this.syncTextEntry();
    if (result.exit) {
      this.options.done();
      return;
    }
    if (result.action !== undefined) void this.execute(result.action);
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    if (this.rootWizard !== undefined) {
      return renderRootTopicWizard(
        this.rootWizard,
        this.knownRepositories(),
        width,
        this.options.tui.terminal.rows,
        this.rootWizardEntry?.render(width)[0],
      );
    }
    if (this.childWizard !== undefined) {
      return renderChildTopicWizard(
        this.childWizard,
        width,
        this.options.tui.terminal.rows,
        this.childWizardEntry?.render(width)[0],
      );
    }
    return renderDashboardView(
      this.viewState,
      this.effectState.snapshot,
      width,
      this.options.tui.terminal.rows,
      this.effectState.phase === "connected"
        ? undefined
        : this.effectState.phase === "reconnecting"
          ? `${phaseLabel(this.effectState)}${this.effectState.message === undefined ? "" : ` · ${this.effectState.message}`}`
          : (this.effectState.message ?? phaseLabel(this.effectState)),
      this.textEntry?.render(width)[0],
    );
  }

  invalidate(): void {
    this.textEntry?.invalidate();
    this.rootWizardEntry?.invalidate();
    this.childWizardEntry?.invalidate();
  }

  async dispose(): Promise<void> {
    this.releaseTextEntry();
    this.releaseRootWizardEntry();
    this.cancelChildWait();
    this.releaseChildWizardEntry();
    this._focused = false;
    await this.runtime.dispose();
  }

  snapshotViewState(): DashboardViewState {
    return this.viewState;
  }

  snapshotRootWizard(): RootTopicWizardState | undefined {
    return this.rootWizard;
  }

  snapshotChildWizard(): ChildTopicWizardState | undefined {
    return this.childWizard;
  }

  private syncTextEntry(): void {
    const editor = this.viewState.editor;
    if (editor === undefined) {
      this.releaseTextEntry();
      return;
    }
    const key = `${editor.kind}:${editor.topicId}`;
    if (this.textEntryKey === key && this.textEntry !== undefined) return;
    this.releaseTextEntry();
    this.textEntry = new StandardTextEntry({
      initialValue: editor.value,
      lineBreaks: editor.kind === "note" ? "space" : "remove",
    });
    this.textEntry.focused = this._focused;
    this.textEntryKey = key;
  }

  private releaseTextEntry(): void {
    this.textEntry?.dispose();
    this.textEntry = undefined;
    this.textEntryKey = undefined;
  }

  private knownRepositories(): readonly string[] {
    return Object.keys(this.options.configuration?.repositories ?? {}).sort();
  }

  private syncRootWizardEntry(): void {
    const wizard = this.rootWizard;
    if (
      wizard === undefined ||
      (wizard.stage !== "name" && wizard.stage !== "repository" && wizard.stage !== "branch")
    ) {
      this.releaseRootWizardEntry();
      return;
    }
    if (this.rootWizardEntryStage === wizard.stage && this.rootWizardEntry !== undefined) return;
    this.releaseRootWizardEntry();
    this.rootWizardEntry = new StandardTextEntry({ initialValue: wizard[wizard.stage] });
    this.rootWizardEntry.focused = this._focused;
    this.rootWizardEntryStage = wizard.stage;
  }

  private releaseRootWizardEntry(): void {
    this.rootWizardEntry?.dispose();
    this.rootWizardEntry = undefined;
    this.rootWizardEntryStage = undefined;
  }

  private handleRootWizardInput(data: string): void {
    const wizard = this.rootWizard!;
    const known = this.knownRepositories();
    if (wizard.stage === "repository" && (matchesKey(data, Key.up) || matchesKey(data, Key.down))) {
      this.rootWizard = moveRootRepositoryHighlight(
        wizard,
        known,
        matchesKey(data, Key.up) ? -1 : 1,
      );
      this.options.tui.requestRender();
      return;
    }
    if (wizard.stage === "repository" && matchesKey(data, Key.tab)) {
      const completed = completeRootRepository(wizard, known);
      this.rootWizard = completed.state;
      if (completed.value !== undefined) {
        this.releaseRootWizardEntry();
        this.syncRootWizardEntry();
      }
      this.options.tui.requestRender();
      return;
    }
    if (wizard.stage === "name" || wizard.stage === "repository" || wizard.stage === "branch") {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
        this.rootWizardEntry?.handleInput(data);
        if (this.rootWizardEntry !== undefined) {
          this.rootWizard = updateRootTopicWizardField(
            wizard,
            this.rootWizardEntry.getValue(),
            known,
          );
        }
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) && this.rootWizardEntry !== undefined) {
        this.rootWizard = updateRootTopicWizardField(
          wizard,
          this.rootWizardEntry.getValue(),
          known,
        );
      }
    }
    const result = handleRootTopicWizardInput(this.rootWizard!, data);
    this.rootWizard = result.state;
    if (result.state === undefined) {
      if (wizard.stage === "confirmation" && this.rootOperation !== undefined) {
        void this.options.client.rejectOperation(this.rootOperation.id);
      }
      this.rootOperation = undefined;
      this.rootPlan = undefined;
      this.releaseRootWizardEntry();
      this.setMessage("Topic creation cancelled.");
      return;
    }
    this.syncRootWizardEntry();
    if (result.submit !== undefined) void this.submitRootTopic(result.submit);
    if (result.confirm) void this.confirmRootTopic();
    if (result.reject) void this.rejectRootTopic();
    this.options.tui.requestRender();
  }

  private async submitRootTopic(input: {
    name: string;
    repository: string;
    branch: string;
  }): Promise<void> {
    if (this.viewState.pending.has("create") || this.options.configuration === undefined) return;
    this.setPending("create", true);
    try {
      const plan =
        this.rootPlan ??
        (await planRootTopicOperation(
          input,
          this.options.configuration,
          this.options.client.clientId,
        ));
      this.rootPlan = plan;
      const handle = await this.options.client.startOperation(plan.request);
      this.rootOperation = {
        id: handle.id,
        ...(handle.confirmation === undefined ? {} : { confirmation: handle.confirmation }),
      };
      if (handle.state === "awaiting-confirmation") {
        if (handle.confirmation === undefined)
          throw new Error("The daemon omitted the Topic confirmation.");
        this.rootWizard = {
          ...this.rootWizard!,
          stage: "confirmation",
          progress: "Topic creation needs confirmation.",
          createdTopicId: plan.topicId,
        };
        return;
      }
      this.acceptRootTopic(plan.topicId);
    } catch (error) {
      this.keepRootWizardFailure(error);
    } finally {
      if (this.rootWizard?.stage !== "confirmation") this.setPending("create", false);
      this.options.tui.requestRender();
    }
  }

  private async confirmRootTopic(): Promise<void> {
    const operation = this.rootOperation;
    const topicId = this.rootWizard?.createdTopicId;
    if (operation?.confirmation === undefined) return;
    try {
      await this.options.client.confirmOperation(operation.id, operation.confirmation);
      this.acceptRootTopic(topicId);
    } catch (error) {
      this.keepRootWizardFailure(error);
    } finally {
      this.setPending("create", false);
    }
  }

  private async rejectRootTopic(): Promise<void> {
    const operation = this.rootOperation;
    if (operation === undefined) return;
    await this.options.client.rejectOperation(operation.id);
    this.rootOperation = undefined;
    this.rootPlan = undefined;
    this.rootWizard = undefined;
    this.releaseRootWizardEntry();
    this.setPending("create", false);
    this.setMessage("Topic creation rejected.");
  }

  private acceptRootTopic(topicId?: DashboardViewState["selectedTopicId"]): void {
    this.acceptedRootTopicId = topicId;
    this.rootWizard = undefined;
    this.rootOperation = undefined;
    this.rootPlan = undefined;
    this.releaseRootWizardEntry();
    this.selectAcceptedRootTopic();
    this.setMessage("Topic provisioning started.");
  }

  private selectAcceptedRootTopic(): void {
    const topicId = this.acceptedRootTopicId;
    const snapshot = this.effectState.snapshot;
    if (
      topicId === undefined ||
      snapshot?.durable.topics.some((row) => row.topic.id === topicId) !== true
    ) {
      return;
    }
    this.viewState = reconcileDashboardSelection(
      { ...this.viewState, selectedTopicId: topicId },
      snapshot,
    );
    this.acceptedRootTopicId = undefined;
  }

  private keepRootWizardFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : "Topic creation failed.";
    if (this.rootWizard !== undefined)
      this.rootWizard = { ...this.rootWizard, stage: "review", error: message };
    this.rootOperation = undefined;
  }

  private syncChildWizardEntry(): void {
    const wizard = this.childWizard;
    if (
      wizard === undefined ||
      (wizard.stage !== "name" && wizard.stage !== "startPoint" && wizard.stage !== "branch")
    ) {
      this.releaseChildWizardEntry();
      return;
    }
    if (this.childWizardEntryStage === wizard.stage && this.childWizardEntry !== undefined) return;
    this.releaseChildWizardEntry();
    this.childWizardEntry = new StandardTextEntry({ initialValue: wizard[wizard.stage] });
    this.childWizardEntry.focused = this._focused;
    this.childWizardEntryStage = wizard.stage;
  }

  private releaseChildWizardEntry(): void {
    this.childWizardEntry?.dispose();
    this.childWizardEntry = undefined;
    this.childWizardEntryStage = undefined;
  }

  private openChildWizard(topicId: DashboardAction["topicId"]): void {
    if (this.options.configuration === undefined || this.viewState.pending.has("create")) return;
    const topic = this.effectState.snapshot?.durable.topics.find(
      (row) => row.topic.id === topicId,
    )?.topic;
    if (
      topic === undefined ||
      topic.parentTopicId !== undefined ||
      topic.setup.state !== "ready" ||
      topic.worktreePath === null
    )
      return;
    this.childPlan = undefined;
    this.childWizard = initialChildTopicWizardState({
      id: topic.id,
      name: topic.name,
      branch: topic.branch,
      worktreePath: topic.worktreePath,
    });
    this.syncChildWizardEntry();
    this.options.tui.requestRender();
  }

  private handleChildWizardInput(data: string): void {
    const wizard = this.childWizard!;
    if (wizard.stage === "name" || wizard.stage === "startPoint" || wizard.stage === "branch") {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
        this.childWizardEntry?.handleInput(data);
        if (this.childWizardEntry !== undefined) {
          this.childWizard = updateChildTopicWizardField(wizard, this.childWizardEntry.getValue());
        }
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) && this.childWizardEntry !== undefined) {
        this.childWizard = updateChildTopicWizardField(wizard, this.childWizardEntry.getValue());
      }
    }
    const result = handleChildTopicWizardInput(this.childWizard!, data);
    if (result.cancelWait) {
      this.cancelChildCreation();
      return;
    }
    this.childWizard = result.state;
    if (result.state === undefined) {
      this.childPlan = undefined;
      this.releaseChildWizardEntry();
      this.setMessage("Child Topic creation cancelled.");
      return;
    }
    this.syncChildWizardEntry();
    if (result.submit !== undefined) void this.submitChildTopic(result.submit);
    if (result.confirm) void this.confirmChildTopic();
    if (result.reject) void this.rejectChildTopic();
    this.options.tui.requestRender();
  }

  private async submitChildTopic(input: ChildTopicWizardSubmit): Promise<void> {
    if (this.viewState.pending.has("create") || this.options.configuration === undefined) return;
    const serial = ++this.childSubmissionSerial;
    this.setPending("create", true);
    try {
      const snapshot = this.effectState.snapshot;
      if (snapshot === undefined) throw new Error("Work state is not available.");
      const plan =
        this.childPlan ??
        (await planChildTopicOperation(
          input,
          snapshot,
          this.options.configuration,
          this.options.client.clientId,
        ));
      if (serial !== this.childSubmissionSerial || this.childWizard === undefined) return;
      this.childPlan = plan;
      const handle = await this.options.client.startOperation(plan.request);
      if (serial !== this.childSubmissionSerial || this.childWizard === undefined) return;
      this.childWizard = {
        ...this.childWizard,
        createdTopicId: plan.topicId,
        operationId: handle.id,
        ...(handle.confirmation === undefined ? {} : { confirmation: handle.confirmation }),
      };
      if (handle.state === "awaiting-confirmation") {
        if (handle.confirmation === undefined)
          throw new Error("The daemon omitted the child Topic confirmation.");
        this.childWizard = {
          ...this.childWizard,
          stage: "confirmation",
          progress: "Child Topic creation needs confirmation.",
        };
        return;
      }
      this.childWizard = {
        ...this.childWizard,
        stage: "submitting",
        progress: "Provisioning child Topic…",
      };
      await this.finishChildTopic(handle.id, plan.topicId, serial);
    } catch (error) {
      if (serial === this.childSubmissionSerial) this.keepChildWizardFailure(error);
    } finally {
      if (serial === this.childSubmissionSerial && this.childWizard?.stage !== "confirmation")
        this.setPending("create", false);
      this.options.tui.requestRender();
    }
  }

  private async confirmChildTopic(): Promise<void> {
    const wizard = this.childWizard;
    if (wizard?.operationId === undefined || wizard.confirmation === undefined) return;
    const serial = this.childSubmissionSerial;
    try {
      await this.options.client.confirmOperation(wizard.operationId, wizard.confirmation);
      if (serial !== this.childSubmissionSerial) return;
      await this.finishChildTopic(wizard.operationId, wizard.createdTopicId, serial);
    } catch (error) {
      if (serial === this.childSubmissionSerial) this.keepChildWizardFailure(error);
    } finally {
      if (serial === this.childSubmissionSerial) this.setPending("create", false);
    }
  }

  private async rejectChildTopic(): Promise<void> {
    const operationId = this.childWizard?.operationId;
    if (operationId === undefined) return;
    await this.options.client.rejectOperation(operationId);
    this.childSubmissionSerial += 1;
    this.childWizard = undefined;
    this.childPlan = undefined;
    this.releaseChildWizardEntry();
    this.setPending("create", false);
    this.setMessage("Child Topic creation rejected.");
  }

  private async finishChildTopic(
    operationId: OperationId,
    topicId: DashboardViewState["selectedTopicId"],
    serial: number,
  ): Promise<void> {
    this.childWaitAbort = new AbortController();
    this.stopChildWatch?.();
    this.stopChildWatch = this.options.client.watchOperation(operationId, (operation) => {
      if (serial !== this.childSubmissionSerial || this.childWizard === undefined) return;
      this.childWizard = {
        ...this.childWizard,
        progress: `Child Topic creation · ${operation.phase}`,
      };
      this.options.tui.requestRender();
    });
    let operation: Awaited<ReturnType<WorkClientRuntime["awaitOperation"]>>;
    try {
      operation = await waitForOperationDeadline(
        this.options.client.awaitOperation(operationId),
        operationId,
        DEFAULT_CLIENT_WAIT_MS,
        this.childWaitAbort.signal,
      );
    } finally {
      this.stopChildWatch?.();
      this.stopChildWatch = undefined;
    }
    this.childWaitAbort = undefined;
    if (serial !== this.childSubmissionSerial) return;
    if (operation.result?.status !== "succeeded") {
      throw new Error(operationResultMessage(operation) ?? "Child Topic creation failed.");
    }
    this.childWizard = undefined;
    this.childPlan = undefined;
    this.releaseChildWizardEntry();
    if (topicId !== undefined) this.viewState = { ...this.viewState, selectedTopicId: topicId };
    this.setMessage("Child Topic created.");
  }

  private cancelChildCreation(): void {
    this.childSubmissionSerial += 1;
    this.cancelChildWait();
    this.childWizard = undefined;
    this.childPlan = undefined;
    this.releaseChildWizardEntry();
    this.setPending("create", false);
    this.setMessage("Stopped waiting. Child Topic provisioning can continue.");
  }

  private cancelChildWait(): void {
    this.childWaitAbort?.abort();
    this.childWaitAbort = undefined;
    this.stopChildWatch?.();
    this.stopChildWatch = undefined;
  }

  private keepChildWizardFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : "Child Topic creation failed.";
    if (this.childWizard !== undefined)
      this.childWizard = { ...this.childWizard, stage: "review", error: message };
    this.cancelChildWait();
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
          await this.startSensitiveAction(action.topicId, "terminal.open");
          return;
        case "RetrySetup":
          await this.startRetrySetup(action.topicId);
          return;
        case "CancelSetup": {
          const cancellation = await this.runtime.requestCancelSetup(action.operationId);
          this.viewState = {
            ...this.viewState,
            confirmation: {
              text: cancellation.text,
              action: { _tag: "ConfirmCancelSetup", topicId: action.topicId },
              rejectAction: { _tag: "RejectCancelSetup", topicId: action.topicId },
            },
          };
          this.setMessage("Setup cancellation needs confirmation.");
          return;
        }
        case "ConfirmCancelSetup": {
          const operation = await this.runtime.confirmCancelSetup();
          this.setMessage(setupCancellationResultMessage(operation));
          return;
        }
        case "RejectCancelSetup":
          await this.runtime.rejectCancelSetup();
          this.setMessage("Setup cancellation rejected. Provisioning continues.");
          return;
        case "ConfirmRetrySetup": {
          await this.options.client.confirmOperation(action.operationId, action.confirmation);
          const operation = await this.options.client.awaitOperation(action.operationId);
          this.setMessage(
            operation.result?.status === "succeeded"
              ? "Setup retry completed."
              : (operationResultMessage(operation) ?? "Setup retry failed."),
          );
          return;
        }
        case "RejectRetrySetup":
          await this.options.client.rejectOperation(action.operationId);
          this.setMessage("Setup retry rejected.");
          return;
        case "OpenMainAgent":
          await this.startSensitiveAction(action.topicId, "agent.open");
          return;
        case "ResetMainAgent":
          await this.startSensitiveAction(action.topicId, "agent.reset");
          return;
        case "ConfirmSensitiveAction": {
          const replacement = selectionAfterTopicDeletion(
            this.effectState.snapshot,
            action.topicId,
          );
          await this.options.client.confirmOperation(action.operationId, action.confirmation);
          const operation = await this.options.client.awaitOperation(action.operationId);
          this.setMessage(sensitiveActionResultMessage(action.kind, operation));
          this.selectAfterSuccessfulDeletion(action.kind, operation, replacement);
          return;
        }
        case "RejectSensitiveAction":
          await this.options.client.rejectOperation(action.operationId);
          this.setMessage(rejectedMessage(action.kind));
          return;
        case "OpenPullRequest":
          this.setMessage(
            actionMessage(
              await this.options.client.ephemeralAction("pull-request", action.topicId),
              "Pull request opened.",
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
        case "ChooseParent":
        case "ChooseChainTarget":
          return;
        case "ChangeParent":
          await this.runtime.mutate(`parent:${action.topicId}`, {
            _tag: "ChangeParent",
            topicId: action.topicId,
            parentTopicId: action.parentTopicId,
          });
          this.setMessage("Parent Topic changed.");
          return;
        case "RemoveParent":
          await this.runtime.mutate(`parent:${action.topicId}`, {
            _tag: "RemoveParent",
            topicId: action.topicId,
          });
          this.setMessage("Parent Topic removed.");
          return;
        case "MoveInChain": {
          try {
            await this.runtime.mutate(`chain:${action.topicId}`, {
              _tag: "MoveInChain",
              topicId: action.topicId,
              target: action.target,
              ...(action.confirmed === true ? { confirmed: true } : {}),
            });
          } catch (error) {
            const confirmation = chainConfirmationMessage(error);
            if (action.confirmed === true || confirmation === undefined) throw error;
            this.viewState = {
              ...this.viewState,
              confirmation: {
                text: confirmation,
                action: { ...action, confirmed: true },
              },
            };
            this.setMessage("Integration Chain move needs confirmation.");
            return;
          }
          this.setMessage("Integration Chain moved.");
          return;
        }
        case "ResetIntegrationTarget":
          await this.runtime.mutate(`chain:${action.topicId}`, {
            _tag: "ResetIntegrationTarget",
            topicId: action.topicId,
          });
          this.setMessage("Integration Target reset.");
          return;
        case "ResetIntegrationBranch":
          await this.runtime.resetIntegrationBranch(action.repository, action.expectedRevision);
          this.setMessage("Integration Branch inference reset. No Branch or Git history moved.");
          return;
        case "AddChild":
          this.openChildWizard(action.topicId);
          return;
        case "Delete":
          await this.startSensitiveAction(action.topicId, "topic.delete");
          return;
      }
    });
  }

  private async startRetrySetup(topicId: DashboardAction["topicId"]): Promise<void> {
    const snapshot = this.effectState.snapshot;
    const configuration = this.options.configuration;
    if (snapshot === undefined) throw new Error("Work state is not available.");
    if (configuration === undefined) throw new Error("Work configuration is not available.");
    let plan = this.retryPlans.get(topicId);
    if (plan === undefined) {
      plan = planRetryTopicOperation(
        topicId,
        snapshot,
        configuration,
        this.options.client.clientId,
      );
      this.retryPlans.set(topicId, plan);
    }
    const handle = await this.options.client.startOperation(plan.request);
    this.retryPlans.delete(topicId);
    if (handle.state === "awaiting-confirmation") {
      if (handle.confirmation === undefined)
        throw new Error("The daemon omitted the Setup retry confirmation.");
      this.viewState = {
        ...this.viewState,
        confirmation: {
          text: "Run the Repository Recipe again from command one?",
          action: {
            _tag: "ConfirmRetrySetup",
            topicId,
            operationId: handle.id,
            confirmation: handle.confirmation,
          },
          rejectAction: { _tag: "RejectRetrySetup", topicId, operationId: handle.id },
        },
      };
      this.setMessage("Setup retry needs confirmation.");
      return;
    }
    this.setMessage("Setup retry started.");
    const operation = await this.options.client.awaitOperation(handle.id);
    this.setMessage(
      operation.result?.status === "succeeded"
        ? "Setup retry completed."
        : (operationResultMessage(operation) ?? "Setup retry failed."),
    );
  }

  private async startSensitiveAction(
    topicId: DashboardAction["topicId"],
    kind: SensitiveActionKind,
  ): Promise<void> {
    const replacement = selectionAfterTopicDeletion(this.effectState.snapshot, topicId);
    const handle = await this.options.client.startOperation({
      fingerprint: `${kind}:${topicId}`,
      topicId,
      input: { version: 1, kind, value: {} },
      phase: "authorizing",
    });
    if (handle.state === "awaiting-confirmation") {
      if (handle.confirmation === undefined)
        throw new Error("The daemon omitted the Action confirmation.");
      const topicName = this.effectState.snapshot?.durable.topics.find(
        (row) => row.topic.id === topicId,
      )?.topic.name;
      this.viewState = {
        ...this.viewState,
        confirmation: {
          text: confirmationText(kind, topicName),
          action: {
            _tag: "ConfirmSensitiveAction",
            topicId,
            operationId: handle.id,
            confirmation: handle.confirmation,
            kind,
          },
          rejectAction: {
            _tag: "RejectSensitiveAction",
            topicId,
            operationId: handle.id,
            kind,
          },
        },
      };
      this.setMessage(`${actionLabel(kind)} needs confirmation.`);
      return;
    }
    const operation = await this.options.client.awaitOperation(handle.id);
    this.setMessage(sensitiveActionResultMessage(kind, operation));
    this.selectAfterSuccessfulDeletion(kind, operation, replacement);
  }

  private selectAfterSuccessfulDeletion(
    kind: SensitiveActionKind,
    operation: Awaited<ReturnType<WorkClientRuntime["awaitOperation"]>>,
    replacement: DashboardViewState["selectedTopicId"],
  ): void {
    if (kind !== "topic.delete" || operation.result?.status !== "succeeded") return;
    if (replacement === undefined) {
      const { selectedTopicId: _selected, ...rest } = this.viewState;
      this.viewState = rest;
    } else {
      this.viewState = { ...this.viewState, selectedTopicId: replacement };
    }
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

function chainConfirmationMessage(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "confirmation-required" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return undefined;
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
function actionLabel(kind: SensitiveActionKind): string {
  if (kind === "terminal.open") return "Terminal opening";
  if (kind === "agent.open") return "Main Agent opening";
  if (kind === "agent.reset") return "Main Agent reset";
  return "Topic deletion";
}

function confirmationText(kind: SensitiveActionKind, topicName?: string): string {
  if (kind === "terminal.open") return "Open a terminal for this Topic?";
  if (kind === "agent.open") return "Open the Main Agent for this Topic?";
  if (kind === "agent.reset") return "Start a new empty Main Agent for this Topic?";
  return (
    `Delete Topic ${topicName ?? "selected Topic"}? ` + "The Branch and Worktree are not deleted."
  );
}

function rejectedMessage(kind: SensitiveActionKind): string {
  return `${actionLabel(kind)} rejected.`;
}

function sensitiveActionResultMessage(
  kind: SensitiveActionKind,
  operation: Awaited<ReturnType<WorkClientRuntime["awaitOperation"]>>,
): string {
  if (operation.result?.status === "cancelled") return rejectedMessage(kind);
  const value = operation.result?.value;
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
  )
    return value.message;
  if (operation.result?.status === "succeeded") {
    if (kind === "terminal.open") return "Terminal opened.";
    if (kind === "agent.open") return "Main Agent opened.";
    if (kind === "agent.reset") return "New Main Agent started.";
    return "Topic deleted.";
  }
  return `${actionLabel(kind)} failed.`;
}

function setupCancellationResultMessage(
  operation: Awaited<ReturnType<WorkClientRuntime["confirmOperation"]>>,
): string {
  if (operation.state === "cancelled") {
    return "Setup cancelled. Completed checkpoints and external artifacts remain.";
  }
  if (operation.state === "setup-interrupted") return "Setup interrupted.";
  if (operation.state === "failed") return operationResultMessage(operation) ?? "Setup failed.";
  if (operation.state === "succeeded") return "Setup completed before cancellation.";
  return "Setup cancellation requested.";
}

function operationResultMessage(
  operation: Awaited<ReturnType<WorkClientRuntime["awaitOperation"]>>,
): string | undefined {
  const value = operation.result?.value;
  return typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : undefined;
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
