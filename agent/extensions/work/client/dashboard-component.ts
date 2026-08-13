import { randomUUID } from "node:crypto";
import {
  Input,
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { DaemonSnapshot, WorkEvent } from "../daemon/protocol.ts";
import type { NewTopic } from "../shared/domain.ts";
import type { TopicMutationResult, WorkActionResult } from "../daemon/topic-service.ts";
import type { MainAgentActionResult, WorkspaceActionResult } from "../daemon/desktop.ts";
import {
  handleDashboardInput,
  hydrateDashboard,
  type DashboardAction,
  initialDashboardState,
  reduceDashboardEvent,
  renderDashboard,
  type DashboardState,
  type TopicWizardStage,
  updateWizardField,
  updateRenameField,
} from "./dashboard.ts";

export interface DashboardClient {
  snapshot(timeoutMs?: number): Promise<DaemonSnapshot>;
  subscribe(
    handler: (event: WorkEvent) => void,
    timeoutMs?: number,
  ): Promise<DaemonSnapshot | void>;
  createTopic(
    input: NewTopic,
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
  deleteTopic(
    topicId: string,
    requestId?: string,
    timeoutMs?: number,
  ): Promise<TopicMutationResult>;
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
}

/** Owns the dashboard client subscription for one full-screen /work view. */
export class WorkDashboardComponent implements Component, Focusable {
  private state: DashboardState = initialDashboardState();
  private _focused = false;
  private wizardInput: Input | undefined;
  private wizardInputStage: Exclude<TopicWizardStage, "review"> | undefined;
  private renameInput: Input | undefined;
  private renameInputTopicId: string | undefined;
  private client: DashboardClient | undefined;
  private removeDisconnect: (() => void) | undefined;
  private disposed = false;
  private connecting = false;
  private hasConnected = false;
  private mutation: PendingMutation | undefined;
  private readonly options: DashboardComponentOptions;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = 100;

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
  }

  render(width: number): string[] {
    const textInput = this.wizardInput ?? this.renameInput;
    const wizardInputLine = textInput?.render(width)[0];
    return renderDashboard(this.state, width, this.options.tui.terminal.rows, wizardInputLine);
  }

  handleInput(data: string): void {
    const wizard = this.state.wizard;
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

    const result = handleDashboardInput(this.state, data);
    this.state = result.state;
    this.syncWizardInput();
    this.syncRenameInput();
    if (result.action !== undefined) this.beginAction(result.action);
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
    input.handleInput(wizard[wizard.stage]);
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
      this.hasConnected = true;
      this.reconnectDelayMs = 100;
      this.options.tui.requestRender();
      if (this.mutation !== undefined) void this.executeMutation(this.mutation, client);
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

  private beginAction(action: DashboardAction): void {
    if (this.mutation !== undefined) return;
    if (this.client === undefined) {
      this.state = withoutSubmission(this.state, "workd is not connected.");
      this.options.tui.requestRender();
      return;
    }
    const mutation: PendingMutation = { action, requestId: randomUUID() };
    this.mutation = mutation;
    void this.executeMutation(mutation, this.client);
  }

  private async executeMutation(mutation: PendingMutation, client: DashboardClient): Promise<void> {
    try {
      const result = await requestMutation(client, mutation);
      if (this.disposed || this.mutation !== mutation) return;
      this.mutation = undefined;
      this.applyMutationResult(result, mutation.action);
    } catch (error) {
      if (this.disposed || this.mutation !== mutation) return;
      // A replacement client retries the same request and client IDs after transport loss.
      if (this.client !== client) return;
      this.mutation = undefined;
      this.state = withoutSubmission(this.state, errorMessage(error));
      this.options.tui.requestRender();
    }
  }

  private applyMutationResult(result: WorkActionResult, action: DashboardAction): void {
    if ("status" in result && result.status === "confirmation-required") {
      this.state = {
        ...withoutSubmission(this.state),
        confirmation: { token: result.token, action: result.action, text: result.text },
        message: result.text,
      };
    } else {
      const message = actionResultMessage(result);
      const { confirmation: _confirmation, ...state } = withoutSubmission(this.state);
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
        this.options.tui.requestRender();
      }
    } catch {
      // The disconnect callback owns reconnect state and retry.
    }
  }
}

interface PendingMutation {
  action: DashboardAction;
  requestId: string;
}

const MUTATION_TIMEOUT_MS = 10 * 60_000;

function requestMutation(
  client: DashboardClient,
  mutation: PendingMutation,
): Promise<WorkActionResult> {
  const { action } = mutation;
  switch (action.type) {
    case "create":
      return client.createTopic(action.input, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "retry":
      return client.retryTopic(action.topicId, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "rename":
      return client.renameTopic(
        action.topicId,
        action.name,
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
    case "confirm":
      return client.confirm(action.token, mutation.requestId, MUTATION_TIMEOUT_MS);
    case "reject":
      return client.reject(action.token, mutation.requestId, MUTATION_TIMEOUT_MS);
  }
}

function withoutSubmission(state: DashboardState, message?: string): DashboardState {
  const { submissionInFlight: _submission, message: _message, ...rest } = state;
  return message === undefined ? rest : { ...rest, message };
}

function actionResultMessage(result: WorkActionResult): string {
  if ("kind" in result) return result.message;
  switch (result.status) {
    case "ready":
      return `Topic ${result.topic.name} is ready.`;
    case "renamed":
      return `Topic renamed to ${result.topic.name}.`;
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
