import { randomUUID } from "node:crypto";
import {
  Input,
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { copyTextToClipboard } from "../../shared/clipboard.ts";
import type { DaemonSnapshot, WorkEvent } from "../daemon/protocol.ts";
import type { IntegrationTarget, NewTopic } from "../shared/domain.ts";
import {
  resolveChildTopicCreationInput,
  type ChildTopicCreationInput,
  type ResolvedChildTopicCreationInput,
} from "./topic-creation.ts";
import type {
  LegacyMigrationApplyResult,
  LegacyMigrationPreviewResult,
  TopicMutationResult,
  WorkActionResult,
} from "../daemon/topic-service.ts";
import type { MainAgentActionResult, WorkspaceActionResult } from "../daemon/desktop.ts";
import {
  handleDashboardInput,
  hydrateDashboard,
  type DashboardAction,
  initialDashboardState,
  advanceShimmer,
  hasShimmeringAgent,
  reduceDashboardEvent,
  renderDashboard,
  submissionKey,
  moveRepositoryHighlight,
  applyRepositoryCompletion,
  type DashboardState,
  type TopicWizardStage,
  updateWizardField,
  updateRenameField,
  updateNoteField,
  openMigrationPreview,
} from "./dashboard.ts";

export interface DashboardClient {
  snapshot(timeoutMs?: number): Promise<DaemonSnapshot>;
  refresh(timeoutMs?: number): Promise<{ refreshed: boolean }>;
  subscribe(
    handler: (event: WorkEvent) => void,
    timeoutMs?: number,
  ): Promise<DaemonSnapshot | void>;
  createTopic(
    input: NewTopic,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  createChildTopic(
    input: ResolvedChildTopicCreationInput,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  retryTopic(topicId: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  renameTopic(
    topicId: string,
    name: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  setTopicNote(
    topicId: string,
    note: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  setTopicFocus(
    topicId: string,
    focused: boolean,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  deleteTopic(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  changeTopicParent(
    topicId: string,
    parentTopicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  removeTopicParent(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  moveTopicInChain(
    topicId: string,
    target: IntegrationTarget,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  resetIntegrationTargets(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
  previewLegacyMigration(
    requestId?: string,
    timeoutMs?: number,
  ): Promise<LegacyMigrationPreviewResult>;
  applyLegacyMigration(
    parentTopicIds?: readonly string[],
    requestId?: string,
    timeoutMs?: number,
  ): Promise<LegacyMigrationApplyResult>;
  accessWorkspace(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<WorkspaceActionResult>;
  openTerminal(topicId: string, requestId?: string, timeoutMs?: number): Promise<WorkActionResult>;
  openMainAgent(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<MainAgentActionResult | WorkActionResult>;
  resetMainAgent(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<MainAgentActionResult | WorkActionResult>;
  openPullRequest(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<WorkActionResult>;
  confirm(token: string, requestId?: string, timeoutMs?: number): Promise<WorkActionResult>;
  reject(token: string, requestId?: string, timeoutMs?: number): Promise<TopicMutationResult>;
  onDisconnect?(handler: (error: Error) => void): () => void;
  close(): void;
}

export interface DashboardComponentOptions {
  tui: Pick<TUI, "requestRender" | "terminal">;
  connect: () => Promise<DashboardClient>;
  done: () => void;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
  /** Resolves child Start Points through Git; the local resolver is the default. */
  resolveChildInput?: typeof resolveChildTopicCreationInput;
  /** Copies a Branch name; the shared native and OSC 52 adapter is the default. */
  copyToClipboard?: typeof copyTextToClipboard;
}

/** Owns the dashboard client subscription for one full-screen /work view. */
export class WorkDashboardComponent implements Component, Focusable {
  private state: DashboardState = initialDashboardState();
  private _focused = false;
  private wizardInput: Input | undefined;
  private wizardInputStage: Exclude<TopicWizardStage, "review"> | undefined;
  private renameInput: Input | undefined;
  private renameInputTopicId: string | undefined;
  private noteInput: Input | undefined;
  private noteInputTopicId: string | undefined;
  private client: DashboardClient | undefined;
  private removeDisconnect: (() => void) | undefined;
  private disposed = false;
  private connecting = false;
  private hasConnected = false;
  private readonly mutations = new Map<string, PendingMutation>();
  private readonly options: DashboardComponentOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = 100;
  private shimmerTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: DashboardComponentOptions) {
    this.options = options;
    void this.connect();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.wizardInput !== undefined) this.wizardInput.focused = value;
    if (this.renameInput !== undefined) this.renameInput.focused = value;
    if (this.noteInput !== undefined) this.noteInput.focused = value;
  }

  render(width: number): string[] {
    const textInput = this.wizardInput ?? this.renameInput ?? this.noteInput;
    const wizardInputLine = textInput?.render(width)[0];
    return renderDashboard(this.state, width, this.options.tui.terminal.rows, wizardInputLine);
  }

  handleInput(data: string): void {
    const wizard = this.state.wizard;
    if (wizard !== undefined && wizard.stage === "repository") {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.state = moveRepositoryHighlight(this.state, matchesKey(data, Key.up) ? -1 : 1);
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.tab)) {
        const result = applyRepositoryCompletion(this.state);
        this.state = result.state;
        if (result.value !== undefined) this.wizardInput?.setValue(result.value);
        this.options.tui.requestRender();
        return;
      }
    }
    if (wizard !== undefined && wizard.stage !== "review") {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
        this.wizardInput?.handleInput(data);
        if (this.wizardInput !== undefined) {
          this.state = updateWizardField(this.state, this.wizardInput.getValue());
        }
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) && this.wizardInput !== undefined) {
        this.state = updateWizardField(this.state, this.wizardInput.getValue());
      }
    }

    if (this.state.rename !== undefined) {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
        this.renameInput?.handleInput(data);
        if (this.renameInput !== undefined) {
          this.state = updateRenameField(this.state, this.renameInput.getValue());
        }
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) && this.renameInput !== undefined) {
        this.state = updateRenameField(this.state, this.renameInput.getValue());
      }
    }

    if (this.state.note !== undefined) {
      if (!matchesKey(data, Key.enter) && !matchesKey(data, Key.escape)) {
        this.noteInput?.handleInput(data.replace(/\r\n?|\n|\u2028|\u2029/g, " "));
        if (this.noteInput !== undefined) {
          const value = this.noteInput.getValue().replace(/\r\n?|\n|\u2028|\u2029/g, " ");
          if (value !== this.noteInput.getValue()) this.noteInput.setValue(value);
          this.state = updateNoteField(this.state, value);
        }
        this.options.tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter) && this.noteInput !== undefined) {
        this.state = updateNoteField(this.state, this.noteInput.getValue());
      }
    }

    const result = handleDashboardInput(this.state, data);
    this.state = result.state;
    this.syncWizardInput();
    this.syncRenameInput();
    this.syncNoteInput();
    if (result.action?.type === "copy-branch") void this.copyBranchName(result.action.branch);
    else if (result.action !== undefined) this.beginAction(result.action);
    if (result.refresh === true) void this.forceRefresh();
    if (result.exit) {
      this.dispose();
      this.options.done();
      return;
    }
    this.options.tui.requestRender();
  }

  invalidate(): void {
    this.wizardInput?.invalidate();
    this.renameInput?.invalidate();
    this.noteInput?.invalidate();
    this.options.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDisconnect?.();
    this.removeDisconnect = undefined;
    const client = this.client;
    this.client = undefined;
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.stopShimmer();
    client?.close();
  }

  snapshotState(): DashboardState {
    return this.state;
  }

  private syncWizardInput(): void {
    const wizard = this.state.wizard;
    if (wizard === undefined || wizard.stage === "review") {
      this.wizardInput = undefined;
      this.wizardInputStage = undefined;
      return;
    }
    if (this.wizardInputStage === wizard.stage && this.wizardInput !== undefined) return;
    const input = new Input();
    input.focused = this.focused;
    input.handleInput(wizard[wizard.stage] ?? "");
    this.wizardInput = input;
    this.wizardInputStage = wizard.stage;
  }

  private syncRenameInput(): void {
    const rename = this.state.rename;
    if (rename === undefined) {
      this.renameInput = undefined;
      this.renameInputTopicId = undefined;
      return;
    }
    if (this.renameInputTopicId === rename.topicId && this.renameInput !== undefined) return;
    const input = new Input();
    input.focused = this.focused;
    input.handleInput(rename.name);
    this.renameInput = input;
    this.renameInputTopicId = rename.topicId;
  }

  private syncNoteInput(): void {
    const editor = this.state.note;
    if (editor === undefined) {
      this.noteInput = undefined;
      this.noteInputTopicId = undefined;
      return;
    }
    if (this.noteInputTopicId === editor.topicId && this.noteInput !== undefined) return;
    const input = new Input();
    input.focused = this.focused;
    input.handleInput(editor.note);
    this.noteInput = input;
    this.noteInputTopicId = editor.topicId;
  }

  private async connect(): Promise<void> {
    if (this.disposed || this.connecting) return;
    this.connecting = true;
    if (this.hasConnected) {
      this.state = { ...this.state, phase: "reconnecting", message: "Reconnecting to workd…" };
      this.options.tui.requestRender();
    }
    let candidate: DashboardClient | undefined;
    try {
      const client = await this.options.connect();
      candidate = client;
      if (this.disposed) {
        client.close();
        return;
      }
      // subscribe returns one atomic baseline. Buffer same-frame events until that baseline is applied.
      const pendingEvents: WorkEvent[] = [];
      let baselineApplied = false;
      const subscribedSnapshot = await client.subscribe((event) => {
        if (baselineApplied) this.receive(event);
        else pendingEvents.push(event);
      });
      const snapshot = subscribedSnapshot ?? (await client.snapshot());
      if (this.disposed) {
        client.close();
        return;
      }
      this.replaceClient(client);
      candidate = undefined;
      this.state = hydrateDashboard(this.state, snapshot);
      baselineApplied = true;
      for (const event of pendingEvents) this.receive(event);
      this.syncShimmer();
      this.hasConnected = true;
      this.reconnectDelayMs = 100;
      this.options.tui.requestRender();
      // Opening the dashboard re-observes daemon state once, without any polling of its own.
      void client.refresh().catch(() => undefined);
      if (this.mutations.size > 0) {
        for (const mutation of this.mutations.values()) void this.executeMutation(mutation, client);
      }
    } catch (error) {
      candidate?.close();
      this.client?.close();
      this.client = undefined;
      if (!this.disposed) {
        this.state = {
          ...this.state,
          phase: "failure",
          message: error instanceof Error ? error.message : "Could not connect to workd.",
        };
        this.options.tui.requestRender();
        this.scheduleReconnect();
      }
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, 2_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private replaceClient(client: DashboardClient): void {
    this.removeDisconnect?.();
    this.client?.close();
    this.client = client;
    this.removeDisconnect = client.onDisconnect?.(() => {
      if (this.disposed || this.client !== client) return;
      this.client = undefined;
      this.removeDisconnect?.();
      this.removeDisconnect = undefined;
      this.state = { ...this.state, phase: "reconnecting", message: "Reconnecting to workd…" };
      this.options.tui.requestRender();
      void this.connect();
    });
  }

  private async copyBranchName(branch: string): Promise<void> {
    try {
      await (this.options.copyToClipboard ?? copyTextToClipboard)(branch);
      if (this.disposed) return;
      this.state = { ...this.state, message: `Copied branch name: ${branch}` };
    } catch (error) {
      if (this.disposed) return;
      this.state = { ...this.state, message: `Could not copy branch name: ${errorMessage(error)}` };
    }
    this.options.tui.requestRender();
  }

  private beginAction(action: RemoteDashboardAction): void {
    const key = submissionKey(action);
    if (this.mutations.has(key)) return;
    if (this.client === undefined) {
      this.state = withoutSubmission(this.state, key, "workd is not connected.");
      this.options.tui.requestRender();
      return;
    }
    const mutation: PendingMutation = { action, requestId: randomUUID(), key };
    this.mutations.set(key, mutation);
    void this.executeMutation(mutation, this.client);
  }

  private async executeMutation(mutation: PendingMutation, client: DashboardClient): Promise<void> {
    try {
      const result = await requestMutation(
        client,
        mutation,
        this.options.resolveChildInput ?? resolveChildTopicCreationInput,
      );
      if (this.disposed || this.mutations.get(mutation.key) !== mutation) return;
      this.mutations.delete(mutation.key);
      this.applyMutationResult(result, mutation.action, mutation.key);
    } catch (error) {
      if (this.disposed || this.mutations.get(mutation.key) !== mutation) return;
      // A replacement client retries the same request and client IDs after transport loss.
      if (this.client !== client) return;
      this.mutations.delete(mutation.key);
      this.state = withoutSubmission(this.state, mutation.key, errorMessage(error));
      this.options.tui.requestRender();
    }
  }

  private applyMutationResult(
    result: WorkActionResult,
    action: DashboardAction,
    key: string,
  ): void {
    if ("status" in result && result.status === "migration-preview") {
      this.state = openMigrationPreview(withoutSubmission(this.state, key), result.preview);
      this.options.tui.requestRender();
      return;
    }
    if ("status" in result && result.status === "confirmation-required") {
      this.state = {
        ...withoutSubmission(this.state, key),
        confirmation: { token: result.token, action: result.action, text: result.text },
        message: result.text,
      };
    } else {
      const message = actionResultMessage(result);
      const { confirmation: _confirmation, ...state } = withoutSubmission(this.state, key);
      if (
        "status" in result &&
        result.status === "denied" &&
        "topic" in result &&
        isTopicAction(action.type)
      ) {
        const unavailable = state.unavailableActions[result.topic.id] ?? [];
        this.state = {
          ...state,
          unavailableActions: {
            ...state.unavailableActions,
            [result.topic.id]: [...new Set([...unavailable, action.type])],
          },
          message,
        };
      } else {
        this.state = { ...state, message };
      }
    }
    this.options.tui.requestRender();
  }

  private receive(event: WorkEvent): void {
    if (this.disposed) return;
    this.state = reduceDashboardEvent(this.state, event);
    this.syncShimmer();
    this.options.tui.requestRender();
    if (event.type === "snapshot-changed") void this.refresh();
    if (event.type === "daemon-stopping") {
      const client = this.client;
      this.removeDisconnect?.();
      this.removeDisconnect = undefined;
      this.client = undefined;
      client?.close();
      void this.connect();
    }
  }

  private async refresh(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    try {
      const snapshot = await client.snapshot();
      if (!this.disposed && this.client === client) {
        this.state = hydrateDashboard(this.state, snapshot);
        this.syncShimmer();
        this.options.tui.requestRender();
      }
    } catch {
      // The disconnect callback owns reconnect state and retry.
    }
  }

  /** Refreshes local repository state, starts the daemon's background PR pass, then re-hydrates. */
  private async forceRefresh(): Promise<void> {
    const client = this.client;
    if (client === undefined) {
      this.state = { ...this.state, message: "workd is not connected." };
      this.options.tui.requestRender();
      return;
    }
    this.state = { ...this.state, message: "Refreshing local repository state…" };
    this.options.tui.requestRender();
    try {
      await client.refresh();
    } catch {
      // The disconnect callback owns reconnect state and retry.
    }
    if (this.disposed || this.client !== client) return;
    await this.refresh();
    if (!this.disposed && this.client === client) {
      this.state = {
        ...this.state,
        message: "Local repository state refreshed; pull requests are updating.",
      };
      this.options.tui.requestRender();
    }
  }

  // A single interval animates all active statuses; it runs only while one exists,
  // so an idle dashboard draws zero extra frames.
  private syncShimmer(): void {
    if (this.disposed) {
      this.stopShimmer();
      return;
    }
    if (hasShimmeringAgent(this.state)) {
      if (this.shimmerTimer !== undefined) return;
      const start = this.options.setInterval ?? globalThis.setInterval;
      this.shimmerTimer = start(() => {
        this.state = advanceShimmer(this.state);
        this.options.tui.requestRender();
      }, SHIMMER_INTERVAL_MS);
    } else {
      this.stopShimmer();
    }
  }

  private stopShimmer(): void {
    if (this.shimmerTimer === undefined) return;
    (this.options.clearInterval ?? globalThis.clearInterval)(this.shimmerTimer);
    this.shimmerTimer = undefined;
  }
}

type RemoteDashboardAction = Exclude<DashboardAction, { type: "copy-branch" }>;

interface PendingMutation {
  action: RemoteDashboardAction;
  requestId: string;
  key: string;
}

const MUTATION_TIMEOUT_MS = 10 * 60_000;

// Shimmer step cadence: ~12 frames per second, still well under the TUI's 16 ms frame floor.
const SHIMMER_INTERVAL_MS = 80;

function requestMutation(
  client: DashboardClient,
  mutation: PendingMutation,
  resolveChildInput: typeof resolveChildTopicCreationInput,
): Promise<WorkActionResult> {
  const { action } = mutation;
  switch (action.type) {
    case "create":
      return client.createTopic(action.input, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "create-child":
      return createChildTopic(client, action.input, mutation.requestId, resolveChildInput);
    case "retry":
      return client.retryTopic(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "rename":
      return client.renameTopic(
        action.topicId,
        action.name,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "set-note":
      return client.setTopicNote(
        action.topicId,
        action.note,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "set-focus":
      return client.setTopicFocus(
        action.topicId,
        action.focused,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "workspace":
      return client.accessWorkspace(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "terminal":
      return client.openTerminal(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "agent":
      return client.openMainAgent(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "reset-agent":
      return client.resetMainAgent(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "pull-request":
      return client.openPullRequest(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "delete":
      return client.deleteTopic(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "change-parent":
      return client.changeTopicParent(
        action.topicId,
        action.parentTopicId,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "remove-parent":
      return client.removeTopicParent(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "move-in-chain":
      return client.moveTopicInChain(
        action.topicId,
        action.target,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "reset-chain":
      return client.resetIntegrationTargets(
        action.topicId,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "migrate-legacy-preview":
      return client.previewLegacyMigration(mutation.requestId, MUTATION_TIMEOUT_MS);
    case "migrate-legacy":
      return client.applyLegacyMigration(
        action.parentTopicIds,
        mutation.requestId,
        MUTATION_TIMEOUT_MS,
      );
    case "confirm":
      return client.confirm(action.token, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "reject":
      return client.reject(action.token, mutation.requestId, MUTATION_TIMEOUT_MS);
  }
}

/**
 * Resolves the wizard Start Point against the Parent Topic Worktree, then submits the child
 * to workd. A Git resolution failure fails the submission with its bounded explanation.
 */
async function createChildTopic(
  client: DashboardClient,
  input: ChildTopicCreationInput,
  requestId: string,
  resolveChildInput: typeof resolveChildTopicCreationInput,
): Promise<WorkActionResult> {
  const resolved = await resolveChildInput(input);
  return client.createChildTopic(resolved, requestId, MUTATION_TIMEOUT_MS);
}

function withoutSubmission(state: DashboardState, key: string, message?: string): DashboardState {
  const { [key]: _removed, ...submissions } = state.submissions;
  const { message: _message, ...rest } = state;
  return message === undefined ? { ...rest, submissions } : { ...rest, submissions, message };
}

function actionResultMessage(result: WorkActionResult): string {
  if ("kind" in result) return result.message;
  switch (result.status) {
    case "ready":
      return `Topic ${result.topic.name} is ready.`;
    case "renamed":
      return `Topic renamed to ${result.topic.name}.`;
    case "note-updated":
      return result.topic.note === undefined ? "Topic Note removed." : "Topic Note saved.";
    case "refocused":
      return result.topic.focused
        ? `Focused Topic ${result.topic.name}.`
        : `Unfocused Topic ${result.topic.name}.`;
    case "chain-changed":
      return `Integration Chain of Topic ${result.topic.name} updated.`;
    case "migration-preview":
      return "Legacy migration preview.";
    case "migration-applied": {
      const applied = result.appliedParentTopicIds.length;
      const kept = result.skipped.length;
      return `Migrated ${applied} legacy famil${applied === 1 ? "y" : "ies"}; ${kept} Topic${kept === 1 ? "" : "s"} unchanged.`;
    }
    case "deleted":
      return "Topic deleted.";
    case "rejected":
      return "Prepared action rejected.";
    case "denied":
      return result.reason;
    case "failed":
    case "timeout":
    case "cancelled":
      return result.reason;
    case "confirmation-required":
      return result.text;
  }
}

function isTopicAction(
  value: DashboardAction["type"],
): value is "retry" | "terminal" | "agent" | "reset-agent" | "delete" {
  return (
    value === "retry" ||
    value === "terminal" ||
    value === "agent" ||
    value === "reset-agent" ||
    value === "delete"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Topic request failed.";
}
