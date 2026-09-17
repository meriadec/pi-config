import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkSnapshot } from "../application/state/index.ts";
import type {
  DurableTopic,
  IntegrationTarget,
  MainAgentActivity,
  OperationId,
  Repository,
  PullRequestObservation,
  TopicId,
} from "../domain/index.ts";
import { pullRequestStatus } from "../domain/index.ts";
import { displayChildOrder } from "../shared/integration-chain.ts";
import { renderMainAgentActivity } from "./main-agent-display.ts";

export type DashboardFocus = "list" | "detail" | "actions";
export type DashboardEditor =
  | {
      readonly kind: "rename";
      readonly topicId: TopicId;
      readonly value: string;
      readonly error?: string;
    }
  | {
      readonly kind: "note";
      readonly topicId: TopicId;
      readonly value: string;
      readonly error?: string;
    };
export type DashboardConfirmation = {
  readonly action: DashboardAction;
  readonly rejectAction?: DashboardAction;
  readonly text: string;
};
export interface ParentTopicChooser {
  readonly topicId: TopicId;
  readonly topicName: string;
  readonly options: ReadonlyArray<{ readonly topicId: TopicId; readonly label: string }>;
  readonly index: number;
}
export interface ChainTargetChooser {
  readonly topicId: TopicId;
  readonly topicName: string;
  readonly options: ReadonlyArray<{
    readonly target: IntegrationTarget;
    readonly label: string;
  }>;
  readonly index: number;
}
export type SensitiveActionKind = "terminal.open" | "agent.open" | "agent.reset" | "topic.delete";
export type DashboardAction =
  | { readonly _tag: "CopyBranch"; readonly topicId: TopicId; readonly branch: string }
  | { readonly _tag: "OpenWorkspace"; readonly topicId: TopicId }
  | { readonly _tag: "OpenTerminal"; readonly topicId: TopicId }
  | { readonly _tag: "RetrySetup"; readonly topicId: TopicId }
  | { readonly _tag: "CancelSetup"; readonly topicId: TopicId; readonly operationId: OperationId }
  | { readonly _tag: "ConfirmCancelSetup"; readonly topicId: TopicId }
  | { readonly _tag: "RejectCancelSetup"; readonly topicId: TopicId }
  | {
      readonly _tag: "ConfirmRetrySetup";
      readonly topicId: TopicId;
      readonly operationId: OperationId;
      readonly confirmation: string;
    }
  | {
      readonly _tag: "RejectRetrySetup";
      readonly topicId: TopicId;
      readonly operationId: OperationId;
    }
  | {
      readonly _tag: "ConfirmSensitiveAction";
      readonly topicId: TopicId;
      readonly operationId: OperationId;
      readonly confirmation: string;
      readonly kind: SensitiveActionKind;
    }
  | {
      readonly _tag: "RejectSensitiveAction";
      readonly topicId: TopicId;
      readonly operationId: OperationId;
      readonly kind: SensitiveActionKind;
    }
  | { readonly _tag: "OpenMainAgent"; readonly topicId: TopicId }
  | { readonly _tag: "ResetMainAgent"; readonly topicId: TopicId }
  | { readonly _tag: "OpenPullRequest"; readonly topicId: TopicId }
  | { readonly _tag: "Rebase"; readonly topicId: TopicId }
  | { readonly _tag: "Rename"; readonly topicId: TopicId; readonly name: string }
  | { readonly _tag: "SetNote"; readonly topicId: TopicId; readonly note: string }
  | { readonly _tag: "MovePartition"; readonly topicId: TopicId; readonly direction: "up" | "down" }
  | { readonly _tag: "ChooseParent"; readonly topicId: TopicId }
  | { readonly _tag: "ChangeParent"; readonly topicId: TopicId; readonly parentTopicId: TopicId }
  | { readonly _tag: "RemoveParent"; readonly topicId: TopicId }
  | { readonly _tag: "ChooseChainTarget"; readonly topicId: TopicId }
  | {
      readonly _tag: "MoveInChain";
      readonly topicId: TopicId;
      readonly target: IntegrationTarget;
      readonly confirmed?: boolean;
    }
  | { readonly _tag: "ResetIntegrationTarget"; readonly topicId: TopicId }
  | {
      readonly _tag: "ResetIntegrationBranch";
      readonly topicId: TopicId;
      readonly repository: Repository;
      readonly expectedRevision: number;
    }
  | { readonly _tag: "AddChild"; readonly topicId: TopicId }
  | { readonly _tag: "Delete"; readonly topicId: TopicId };

export interface DashboardActionFeedback {
  readonly topicId: TopicId;
  readonly action: DashboardAction["_tag"];
  readonly status: "working" | "success" | "failure" | "busy";
  readonly text: string;
}

export interface DashboardViewState {
  readonly selectedTopicId?: TopicId;
  /** The selected row position in the last reconciled ordering. */
  readonly selectionIndex?: number;
  readonly sidebarOpen: boolean;
  readonly focus: DashboardFocus;
  readonly focusedAction: number;
  readonly shimmerPhase: number;
  readonly creationAvailable: boolean;
  readonly editor?: DashboardEditor;
  readonly confirmation?: DashboardConfirmation;
  readonly parentChooser?: ParentTopicChooser;
  readonly chainTargetChooser?: ChainTargetChooser;
  readonly message?: string;
  readonly actionFeedback?: DashboardActionFeedback;
  readonly pending: ReadonlySet<string>;
}

export interface DashboardInputResult {
  readonly state: DashboardViewState;
  readonly action?: DashboardAction;
  readonly exit?: boolean;
}

export const initialDashboardViewState = (): DashboardViewState => ({
  sidebarOpen: false,
  focus: "list",
  focusedAction: 0,
  shimmerPhase: 0,
  creationAvailable: false,
  pending: new Set(),
});

export function reconcileDashboardSelection(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
): DashboardViewState {
  const topics = orderedTopics(snapshot);
  if (topics.length === 0) {
    const { selectedTopicId: _selected, selectionIndex: _index, ...rest } = state;
    return { ...rest, sidebarOpen: false, focus: "list", focusedAction: 0 };
  }
  const selectedIndex = topics.findIndex((topic) => topic.id === state.selectedTopicId);
  if (selectedIndex >= 0) {
    return selectedIndex === state.selectionIndex
      ? state
      : { ...state, selectionIndex: selectedIndex };
  }
  const selectionIndex = Math.min(state.selectionIndex ?? 0, topics.length - 1);
  return { ...state, selectedTopicId: topics[selectionIndex]!.id, selectionIndex };
}

export function handleDashboardViewInput(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  data: string,
): DashboardInputResult {
  const topics = orderedTopics(snapshot);
  if (matchesKey(data, Key.ctrl("c"))) return { state, exit: true };
  if (state.chainTargetChooser !== undefined) {
    const chooser = state.chainTargetChooser;
    if (matchesKey(data, Key.escape)) {
      return { state: withoutChainTargetChooser(state, "Integration Chain move cancelled.") };
    }
    if (matchesKey(data, Key.down) || data === "j") {
      return { state: moveChainTargetChooser(state, 1) };
    }
    if (matchesKey(data, Key.up) || data === "k") {
      return { state: moveChainTargetChooser(state, -1) };
    }
    if (!matchesKey(data, Key.enter)) return { state };
    const option = chooser.options[chooser.index];
    if (option === undefined || state.pending.has(chooser.topicId)) return { state };
    return {
      state: withoutChainTargetChooser(state),
      action: { _tag: "MoveInChain", topicId: chooser.topicId, target: option.target },
    };
  }
  if (state.parentChooser !== undefined) {
    const chooser = state.parentChooser;
    if (matchesKey(data, Key.escape)) {
      return { state: withoutParentChooser(state, "Parent Topic change cancelled.") };
    }
    if (matchesKey(data, Key.down) || data === "j") {
      return { state: moveParentChooser(state, 1) };
    }
    if (matchesKey(data, Key.up) || data === "k") {
      return { state: moveParentChooser(state, -1) };
    }
    if (!matchesKey(data, Key.enter)) return { state };
    const option = chooser.options[chooser.index];
    if (option === undefined || state.pending.has(chooser.topicId)) return { state };
    return {
      state: withoutParentChooser(state),
      action: {
        _tag: "ChangeParent",
        topicId: chooser.topicId,
        parentTopicId: option.topicId,
      },
    };
  }
  if (state.confirmation !== undefined) {
    if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
      return {
        state: withoutConfirmation(state),
        action: state.confirmation.action,
      };
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
      return {
        state: withoutConfirmation(state),
        ...(state.confirmation.rejectAction === undefined
          ? {}
          : { action: state.confirmation.rejectAction }),
      };
    }
    return { state };
  }
  if (state.editor !== undefined) {
    if (matchesKey(data, Key.escape)) return { state: withoutEditor(state) };
    if (!matchesKey(data, Key.enter)) return { state };
    const value = state.editor.value.trim();
    if (state.editor.kind === "rename" && value.length === 0) {
      return {
        state: { ...state, editor: { ...state.editor, error: "Topic name must not be empty." } },
      };
    }
    if (value.length > 200) {
      const error =
        state.editor.kind === "rename"
          ? "Topic name must not exceed 200 characters."
          : "Topic Note must not exceed 200 characters.";
      return { state: { ...state, editor: { ...state.editor, error } } };
    }
    return {
      state: withoutEditor(state),
      action:
        state.editor.kind === "rename"
          ? { _tag: "Rename", topicId: state.editor.topicId, name: value }
          : { _tag: "SetNote", topicId: state.editor.topicId, note: value },
    };
  }
  if (matchesKey(data, Key.escape)) return { state, exit: true };
  if (data === "q" || data === "Q") {
    if (!state.sidebarOpen) return { state };
    return {
      state: { ...state, sidebarOpen: false, focus: "list", focusedAction: 0 },
    };
  }
  if (topics.length === 0) return { state };
  const selected = selectedTopic(state, topics) ?? topics[0]!;
  const topicBusy = state.pending.has(selected.id);
  if ((data === "J" || data === "K") && state.focus === "list" && !topicBusy) {
    return actionResult(state, {
      _tag: "MovePartition",
      topicId: selected.id,
      direction: data === "J" ? "down" : "up",
    });
  }
  if (data === "n" && state.focus === "list" && !topicBusy) {
    return {
      state: {
        ...state,
        editor: { kind: "note", topicId: selected.id, value: selected.note ?? "" },
      },
    };
  }
  if (data === "s" && state.focus === "list" && !topicBusy) {
    const rebase = topicActions(state, snapshot).find((item) => item.action._tag === "Rebase");
    if (rebase?.available) return actionResult(state, rebase.action);
    return rebase === undefined
      ? { state }
      : { state: { ...state, message: rebase.reason ?? "Rebase is unavailable." } };
  }
  if (data === "m" && state.focus === "list" && !topicBusy) {
    const agent = topicActions(state, snapshot).find(
      (item) => item.action._tag === "OpenMainAgent",
    );
    if (agent?.available) return actionResult(state, agent.action);
    return { state };
  }
  if (data === "p" && state.focus === "list" && !topicBusy) {
    const pullRequest = topicActions(state, snapshot).find(
      (item) => item.action._tag === "OpenPullRequest",
    );
    if (pullRequest?.available) return actionResult(state, pullRequest.action);
    if (pullRequest === undefined)
      return { state: { ...state, message: "The Topic has no pull request." } };
    return { state };
  }
  if (data === "o" && state.focus === "list" && !topicBusy) {
    const workspace = topicActions(state, snapshot).find(
      (item) => item.action._tag === "OpenWorkspace",
    );
    if (workspace?.available) return actionResult(state, workspace.action);
    return { state };
  }
  if (data === "t" && state.focus === "list" && !topicBusy) {
    const terminal = topicActions(state, snapshot).find(
      (item) => item.action._tag === "OpenTerminal",
    );
    if (terminal?.available) return actionResult(state, terminal.action);
    return { state };
  }
  if (matchesKey(data, Key.down) || data === "j") {
    if (state.focus === "actions") return moveAction(state, snapshot, 1);
    if (state.focus === "list") return { state: moveSelection(state, topics, 1) };
    return { state };
  }
  if (matchesKey(data, Key.up) || data === "k") {
    if (state.focus === "actions") return moveAction(state, snapshot, -1);
    if (state.focus === "list") return { state: moveSelection(state, topics, -1) };
    return { state };
  }
  if (matchesKey(data, Key.right) || data === "l") {
    if (!state.sidebarOpen) {
      return { state: { ...state, sidebarOpen: true, focus: "detail" } };
    }
    if (state.focus === "list") return { state: { ...state, focus: "detail" } };
    if (state.focus === "detail") {
      return {
        state: { ...state, focus: "actions", focusedAction: firstAvailableAction(state, snapshot) },
      };
    }
    return { state };
  }
  if (matchesKey(data, Key.left) || data === "h") {
    if (state.focus === "actions") return { state: { ...state, focus: "detail" } };
    if (state.focus === "detail") return { state: { ...state, focus: "list" } };
    return { state };
  }
  if (matchesKey(data, Key.enter)) {
    if (!state.sidebarOpen || state.focus !== "actions") {
      return {
        state: {
          ...state,
          sidebarOpen: true,
          focus: "actions",
          focusedAction: firstAvailableAction(state, snapshot),
        },
      };
    }
    const action = topicActions(state, snapshot)[state.focusedAction];
    if (action === undefined) return { state };
    if (!action.available) {
      return { state: { ...state, message: action.reason ?? "Action is unavailable." } };
    }
    if (action.action._tag === "ResetIntegrationBranch") {
      return {
        state: {
          ...state,
          confirmation: {
            text:
              `Reset the inferred Integration Branch for ${action.action.repository}? ` +
              "No Branch moves and no Git history changes.",
            action: action.action,
          },
        },
      };
    }
    if (action.action._tag === "Rename") {
      return {
        state: { ...state, editor: { kind: "rename", topicId: selected.id, value: selected.name } },
      };
    }
    if (action.action._tag === "SetNote") {
      return {
        state: {
          ...state,
          editor: { kind: "note", topicId: selected.id, value: selected.note ?? "" },
        },
      };
    }
    if (action.action._tag === "ChooseParent") {
      const options = validParentTopics(snapshot, selected).map((candidate) => ({
        topicId: candidate.id,
        label: candidate.name,
      }));
      if (options.length === 0) return { state };
      return {
        state: {
          ...state,
          sidebarOpen: false,
          focus: "list",
          parentChooser: { topicId: selected.id, topicName: selected.name, options, index: 0 },
        },
      };
    }
    if (action.action._tag === "ChooseChainTarget") {
      const options = validChainTargets(snapshot, selected);
      if (options.length < 2) return { state };
      return {
        state: {
          ...state,
          sidebarOpen: false,
          focus: "list",
          chainTargetChooser: {
            topicId: selected.id,
            topicName: selected.name,
            options,
            index: 0,
          },
        },
      };
    }
    return actionResult(state, action.action);
  }
  return { state };
}

/** Updates the active editor from the standard TUI text-entry component. */
export function updateDashboardEditorValue(
  state: DashboardViewState,
  value: string,
): DashboardViewState {
  if (state.editor === undefined) return state;
  const { error: _error, ...editor } = state.editor;
  const normalized = editor.kind === "note" ? value.replace(/\r\n?|\n|\u2028|\u2029/g, " ") : value;
  return { ...state, editor: { ...editor, value: normalized } };
}

export interface TopicActionView {
  readonly label: string;
  readonly action: DashboardAction;
  readonly available: boolean;
  readonly reason?: string;
}

export function topicActions(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
): readonly TopicActionView[] {
  const topic = selectedTopic(state, orderedTopics(snapshot));
  if (topic === undefined) return [];
  const pullRequest = snapshot?.observed.pullRequests.find(
    (entry) => entry.topicId === topic.id,
  )?.value;
  const hasPullRequest = pullRequest !== undefined || topic.pullRequest !== undefined;
  const ready = topic.setup.state === "ready" && topic.worktreePath !== null;
  const rebaseReasons = rebaseUnavailabilityReasons(snapshot, topic);
  const denied = (action: SensitiveActionKind | "topic.run-setup") =>
    snapshot?.observed.policies?.some(
      (policy) =>
        policy.action === action &&
        policy.decision === "deny" &&
        policy.scope.kind === "topic" &&
        policy.scope.topicId === topic.id,
    ) === true;
  const activeTopicWork =
    snapshot?.durable.operations.some(
      (operation) =>
        operation.topicId === topic.id &&
        (operation.state === "accepted" ||
          operation.state === "awaiting-confirmation" ||
          operation.state === "running"),
    ) === true;
  const cancellableSetup = snapshot?.durable.operations.find(
    (operation) =>
      operation.topicId === topic.id &&
      operation.input.kind === "topic.provision" &&
      (operation.state === "accepted" || operation.state === "running"),
  );
  const retryState =
    topic.setup.state === "setup-failed" || topic.setup.state === "setup-interrupted";
  const retryDenied = denied("topic.run-setup");
  const retryReason = retryDenied
    ? "Denied by topic.run-setup Action policy"
    : activeTopicWork
      ? "Topic work is active"
      : topic.worktreePath === null
        ? "Existing Topic Worktree unavailable"
        : undefined;
  const terminalDenied = denied("terminal.open");
  const openAgentDenied = denied("agent.open");
  const resetAgentDenied = denied("agent.reset");
  const deleteDenied = denied("topic.delete");
  const repositoryState = snapshot?.durable.repositoryStates.find(
    (row) => row.repository === topic.repository,
  );
  const inferredIntegrationBranch =
    repositoryState?.source === "inferred" ||
    (repositoryState?.source === undefined &&
      repositoryState?.inferredIntegrationBranch !== undefined);
  const childCreationAvailable =
    state.creationAvailable &&
    topic.parentTopicId === undefined &&
    ready &&
    !state.pending.has("create");
  const children = (snapshot?.durable.topics ?? []).filter(
    (row) => row.topic.parentTopicId === topic.id,
  );
  const parentCandidates = validParentTopics(snapshot, topic);
  const canChooseParent = children.length === 0 && parentCandidates.length > 0;
  const relationshipAvailable = ready && topic.chainState !== "pending";
  const relationshipReason =
    topic.chainState === "pending" ? "Topic insertion is pending" : "Topic setup is not ready";
  const item = (
    label: string,
    action: DashboardAction,
    available = true,
    reason?: string,
  ): TopicActionView => ({
    label,
    action,
    available,
    ...(reason === undefined ? {} : { reason }),
  });
  return [
    item("Copy Branch Name", { _tag: "CopyBranch", topicId: topic.id, branch: topic.branch }),
    ...(cancellableSetup === undefined
      ? []
      : [
          item("Cancel Setup", {
            _tag: "CancelSetup",
            topicId: topic.id,
            operationId: cancellableSetup.id,
          }),
        ]),
    ...(retryState
      ? [
          item(
            "Retry Setup",
            { _tag: "RetrySetup", topicId: topic.id },
            retryReason === undefined,
            retryReason,
          ),
        ]
      : []),
    item("Access Topic Workspace", { _tag: "OpenWorkspace", topicId: topic.id }),
    item(
      "Open Terminal",
      { _tag: "OpenTerminal", topicId: topic.id },
      ready && !terminalDenied,
      terminalDenied ? "Denied by Action policy" : "Worktree unavailable",
    ),
    item(
      "Open Main Agent",
      { _tag: "OpenMainAgent", topicId: topic.id },
      ready && !openAgentDenied,
      openAgentDenied ? "Denied by Action policy" : "Worktree unavailable",
    ),
    item(
      "Start New Main Agent",
      { _tag: "ResetMainAgent", topicId: topic.id },
      ready && !resetAgentDenied,
      resetAgentDenied ? "Denied by Action policy" : "Worktree unavailable",
    ),
    ...(hasPullRequest
      ? [
          item("Open Pull Request in Browser", {
            _tag: "OpenPullRequest",
            topicId: topic.id,
          }),
        ]
      : []),
    item(
      "Rebase onto Integration Target",
      { _tag: "Rebase", topicId: topic.id },
      rebaseReasons.length === 0,
      rebaseReasons.join(" · "),
    ),
    item("Rename Topic", { _tag: "Rename", topicId: topic.id, name: topic.name }),
    item(topic.note === undefined ? "Add Note" : "Edit Note", {
      _tag: "SetNote",
      topicId: topic.id,
      note: topic.note ?? "",
    }),
    ...(childCreationAvailable
      ? [item("Add Child Topic", { _tag: "AddChild", topicId: topic.id })]
      : []),
    ...(canChooseParent
      ? [
          item(
            "Change Parent Topic",
            { _tag: "ChooseParent", topicId: topic.id },
            relationshipAvailable,
            relationshipAvailable ? undefined : relationshipReason,
          ),
        ]
      : []),
    ...(topic.parentTopicId === undefined
      ? []
      : [
          item(
            "Remove Parent Topic",
            { _tag: "RemoveParent", topicId: topic.id },
            relationshipAvailable,
            relationshipAvailable ? undefined : relationshipReason,
          ),
        ]),
    ...(topic.parentTopicId !== undefined && validChainTargets(snapshot, topic).length > 1
      ? [
          item(
            "Move in Integration Chain",
            { _tag: "ChooseChainTarget", topicId: topic.id },
            relationshipAvailable,
            relationshipAvailable ? undefined : relationshipReason,
          ),
        ]
      : []),
    ...(topic.parentTopicId === undefined && children.length > 0
      ? [
          item(
            "Reset Integration Target",
            { _tag: "ResetIntegrationTarget", topicId: topic.id },
            ready,
            ready ? undefined : "Topic setup is not ready",
          ),
        ]
      : []),
    ...(inferredIntegrationBranch && repositoryState !== undefined
      ? [
          item("Reset Integration Branch", {
            _tag: "ResetIntegrationBranch",
            topicId: topic.id,
            repository: topic.repository,
            expectedRevision: repositoryState.rowRevision,
          }),
        ]
      : []),
    item(
      "Delete Topic",
      { _tag: "Delete", topicId: topic.id },
      !deleteDenied,
      "Denied by Action policy",
    ),
  ];
}

function renderParentChooser(chooser: ParentTopicChooser, width: number): string[] {
  return [
    bright(`CHANGE PARENT TOPIC · ${chooser.topicName}`),
    "",
    ...chooser.options.map((option, index) =>
      truncateToWidth(`${index === chooser.index ? ">" : " "} ${option.label}`, width),
    ),
    "",
    "No Branch moves and no Git history changes.",
    "j/k or ↑/↓ move · Enter apply · Escape cancel",
  ];
}

function moveParentChooser(state: DashboardViewState, delta: number): DashboardViewState {
  const chooser = state.parentChooser;
  if (chooser === undefined || chooser.options.length === 0) return state;
  const index = Math.max(0, Math.min(chooser.options.length - 1, chooser.index + delta));
  return { ...state, parentChooser: { ...chooser, index } };
}

function withoutParentChooser(state: DashboardViewState, message?: string): DashboardViewState {
  const { parentChooser: _chooser, ...rest } = state;
  return message === undefined ? rest : { ...rest, message };
}

function validChainTargets(
  snapshot: WorkSnapshot | undefined,
  topic: DurableTopic,
): ChainTargetChooser["options"] {
  if (topic.parentTopicId === undefined || topic.chainState === "pending") return [];
  const topics = (snapshot?.durable.topics ?? []).map((row) => row.topic);
  const parent = topics.find(
    (candidate) =>
      candidate.id === topic.parentTopicId &&
      candidate.parentTopicId === undefined &&
      candidate.repository === topic.repository,
  );
  if (parent === undefined) return [];
  const repositoryState = snapshot?.durable.repositoryStates.find(
    (state) => state.repository === topic.repository,
  );
  const branch = repositoryState?.integrationBranch ?? repositoryState?.inferredIntegrationBranch;
  const siblings = displayChildOrder(
    topics.filter(
      (candidate) =>
        candidate.id !== topic.id &&
        candidate.parentTopicId === parent.id &&
        candidate.repository === topic.repository &&
        candidate.chainState !== "pending",
    ),
  );
  return [
    {
      target: { kind: "integration-branch" },
      label: `${branch ?? "Integration Branch"} (first in the chain)`,
    },
    ...siblings.map((candidate) => ({
      target: { kind: "topic" as const, topicId: candidate.id },
      label: `After ${candidate.name}`,
    })),
  ];
}

function renderChainTargetChooser(chooser: ChainTargetChooser, width: number): string[] {
  return [
    bright(`MOVE IN INTEGRATION CHAIN · ${chooser.topicName}`),
    "",
    ...chooser.options.map((option, index) =>
      truncateToWidth(`${index === chooser.index ? ">" : " "} ${option.label}`, width),
    ),
    "",
    "No Branch moves and no Git history changes.",
    "j/k or ↑/↓ move · Enter apply · Escape cancel",
  ];
}

function moveChainTargetChooser(state: DashboardViewState, delta: number): DashboardViewState {
  const chooser = state.chainTargetChooser;
  if (chooser === undefined || chooser.options.length === 0) return state;
  const index = Math.max(0, Math.min(chooser.options.length - 1, chooser.index + delta));
  return { ...state, chainTargetChooser: { ...chooser, index } };
}

function withoutChainTargetChooser(
  state: DashboardViewState,
  message?: string,
): DashboardViewState {
  const { chainTargetChooser: _chooser, ...rest } = state;
  return message === undefined ? rest : { ...rest, message };
}

function validParentTopics(
  snapshot: WorkSnapshot | undefined,
  topic: DurableTopic,
): DurableTopic[] {
  return (snapshot?.durable.topics ?? [])
    .map((row) => row.topic)
    .filter(
      (candidate) =>
        candidate.id !== topic.id &&
        candidate.id !== topic.parentTopicId &&
        candidate.repository === topic.repository &&
        candidate.parentTopicId === undefined &&
        candidate.setup.state === "ready",
    );
}

/** Every volatile guard is visible before the rebase action can run. */
function rebaseUnavailabilityReasons(
  snapshot: WorkSnapshot | undefined,
  topic: DurableTopic,
): string[] {
  const reasons: string[] = [];
  const observation = topicObservation(snapshot, topic.id);
  const status = observation?.integrationStatus;
  if (topic.setup.state !== "ready" || topic.worktreePath === null)
    reasons.push("Topic setup is not ready");
  if (observation?.orphan) reasons.push("Worktree is missing");
  if (status?.kind !== "behind") {
    reasons.push(
      status?.kind === "current"
        ? "Already Current"
        : status?.kind === "conflict"
          ? "Integration conflict"
          : (status?.diagnostic ?? "Integration Status is Unknown"),
    );
  }
  const pullRequest = snapshot?.observed.pullRequests.find(
    (item) => item.topicId === topic.id,
  )?.value;
  if (pullRequest?.state === "open")
    reasons.push(`Open pull request #${pullRequest.identity.number}`);
  if (observation?.gitOperationState !== undefined && observation.gitOperationState !== "none") {
    const state = observation.gitOperationConflict ? "conflict" : "pending";
    reasons.push(`${observation.gitOperationState} ${state}`);
  }
  if (observation?.worktreeClean !== true)
    reasons.push(
      observation?.worktreeClean === false
        ? "Worktree has local changes"
        : "Worktree state is unknown",
    );
  if (observation?.checkedOutBranch !== topic.branch)
    reasons.push(
      observation?.checkedOutBranch == null
        ? `Branch ${topic.branch} is not checked out`
        : `Checked-out Branch is ${observation.checkedOutBranch}`,
    );
  if (topic.integrationTarget?.kind === "topic") {
    const target = topicObservation(snapshot, topic.integrationTarget.topicId);
    if (target?.gitOperationState !== undefined && target.gitOperationState !== "none")
      reasons.push(`Integration Target has ${target.gitOperationState} in progress`);
  }
  const activity = observation?.mainAgentActivity;
  if (activity === "starting" || activity === "thinking" || activity === "thinking-sub")
    reasons.push(`Main Agent is ${activity}`);
  return reasons;
}

export interface DashboardLayout {
  readonly wide: boolean;
  readonly listWidth: number;
  readonly sidebarWidth: number;
}

export function calculateDashboardLayout(width: number, sidebarOpen: boolean): DashboardLayout {
  const safeWidth = Math.max(1, width);
  const wide = sidebarOpen && safeWidth >= 96;
  const sidebarWidth = wide ? Math.max(30, Math.floor(safeWidth * 0.34)) : safeWidth;
  return {
    wide,
    listWidth: wide ? safeWidth - sidebarWidth - 1 : safeWidth,
    sidebarWidth,
  };
}

export function renderDashboardView(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  width: number,
  height: number,
  phaseMessage?: string,
  editorInputLine?: string,
): string[] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  if (state.chainTargetChooser !== undefined)
    return fit(
      renderChainTargetChooser(state.chainTargetChooser, safeWidth),
      safeWidth,
      safeHeight,
    );
  if (state.parentChooser !== undefined)
    return fit(renderParentChooser(state.parentChooser, safeWidth), safeWidth, safeHeight);
  if (state.editor !== undefined)
    return fit(renderEditor(state.editor, safeWidth, editorInputLine), safeWidth, safeHeight);
  if (state.confirmation !== undefined)
    return fit(renderConfirmation(state.confirmation, safeWidth), safeWidth, safeHeight);
  if (snapshot === undefined)
    return fit(
      ["Work", "", phaseMessage ?? "Loading Work state…", "", "esc quit"],
      safeWidth,
      safeHeight,
    );
  const stateWithSelection = reconcileDashboardSelection(state, snapshot);
  const topics = orderedTopics(snapshot);
  if (topics.length === 0) {
    return fit(
      [
        "Work",
        ...(phaseMessage === undefined ? [] : [brightRed(phaseMessage)]),
        "",
        "No Topics.",
        "",
        "a add Topic · r refresh · esc quit",
      ],
      safeWidth,
      safeHeight,
    );
  }
  const layout = calculateDashboardLayout(safeWidth, stateWithSelection.sidebarOpen);
  const list = renderList(
    stateWithSelection,
    snapshot,
    topics,
    layout.listWidth,
    safeHeight,
    phaseMessage,
  );
  if (!stateWithSelection.sidebarOpen) return fit(list, safeWidth, safeHeight);
  const side = renderDetails(stateWithSelection, snapshot, layout.sidebarWidth, safeHeight);
  if (!layout.wide) return fit(side, safeWidth, safeHeight);
  const listWidth = layout.listWidth;
  const lines: string[] = [];
  for (let index = 0; index < Math.max(list.length, side.length); index += 1) {
    lines.push(`${pad(list[index] ?? "", listWidth)}│${side[index] ?? ""}`);
  }
  return fit(lines, safeWidth, safeHeight);
}

function renderList(
  state: DashboardViewState,
  snapshot: WorkSnapshot,
  topics: readonly DurableTopic[],
  width: number,
  height: number,
  phaseMessage?: string,
): string[] {
  const columns = wideTopicColumns(state, snapshot, topics, width);
  const lines = [
    bright("Work"),
    ...(phaseMessage === undefined ? [] : [brightRed(phaseMessage)]),
    dim(
      columns === undefined
        ? `  ${INTEGRATION_HEADER} TOPIC · NOTE · REPOSITORY · PR · SETUP · MAIN AGENT`
        : renderWideHeader(columns),
    ),
  ];
  const rowCapacity = Math.max(1, height - lines.length - 2);
  const visible = visibleTopicsWithinRows(topics, state.selectedTopicId, rowCapacity);
  let previousPartition: number | undefined;
  for (const topic of visible) {
    if (previousPartition !== undefined && topic.partition !== previousPartition) lines.push("");
    previousPartition = topic.partition;
    const selected = topic.id === state.selectedTopicId;
    const observation = topicObservation(snapshot, topic.id);
    const orphan = observation?.orphan === true;
    const inactive = isInactive(observation?.mainAgentActivity);
    const displayName = topicDisplayName(topic, topics);
    const setup = setupCell(state, snapshot, topic);
    const activity = renderListActivity(
      observation?.mainAgentActivity ?? "stopped",
      state.shimmerPhase,
    );
    const pullRequest = pullRequestCell(snapshot, topic.id);
    const integration = integrationGlyph(observation?.integrationStatus.kind ?? "unknown");
    const prefix = selected ? (state.focus === "list" ? "> " : "* ") : "  ";
    const setupSegment = setup === "" ? "" : ` · ${setup}`;
    const activitySegment = activity === "" ? "" : ` · ${activity}`;
    const pullRequestSegment = pullRequest === "" ? "" : ` · ${pullRequest}`;
    const note =
      topic.note === undefined ? "" : renderTopicNote(topic.note, { selected, orphan, inactive });
    const compactNote = state.sidebarOpen || note === "" ? "" : ` ${note}`;
    const row =
      columns === undefined
        ? truncateToWidth(
            `${prefix}${integration} ${displayName}${compactNote}${setupSegment}${activitySegment}${pullRequestSegment}`,
            width,
          )
        : `${prefix}${pad(integration, columns.integration)} ${pad(displayName, columns.name)} ${pad(note, columns.note)} ${pad(topic.repository, columns.repository)} ${pad(pullRequest, columns.pullRequest)} ${pad(setup, columns.setup)} ${pad(activity, columns.mainAgent)}`;
    const styled = orphan ? brightRed(row) : dimIfInactive(row, observation?.mainAgentActivity);
    lines.push(selected ? highlight(styled, width) : styled);
  }
  while (lines.length < Math.max(1, height - 2)) lines.push("");
  lines.push(
    state.message ?? "",
    "a add Topic · j/k select · l detail · Enter actions · J/K move Partition · n note · s rebase · m agent · o workspace · p pull request · t terminal · r refresh · q details · esc quit",
  );
  return lines;
}

/** Keeps the selected Topic near the center and includes Partition separator rows. */
export function visibleTopicsWithinRows(
  topics: readonly DurableTopic[],
  selectedTopicId: TopicId | undefined,
  rowCapacity: number,
): readonly DurableTopic[] {
  const visibleTopics = (capacity: number): readonly DurableTopic[] => {
    if (topics.length <= capacity) return topics;
    const selected = Math.max(
      0,
      topics.findIndex((topic) => topic.id === selectedTopicId),
    );
    const start = Math.max(
      0,
      Math.min(topics.length - capacity, selected - Math.floor(capacity / 2)),
    );
    return topics.slice(start, start + capacity);
  };
  for (
    let capacity = Math.min(topics.length, Math.max(1, rowCapacity));
    capacity > 0;
    capacity -= 1
  ) {
    const visible = visibleTopics(capacity);
    const separators = visible
      .slice(1)
      .filter((topic, index) => topic.partition !== visible[index]!.partition).length;
    if (visible.length + separators <= rowCapacity) return visible;
  }
  return visibleTopics(1);
}

interface TopicColumns {
  readonly integration: number;
  readonly name: number;
  readonly note: number;
  readonly repository: number;
  readonly pullRequest: number;
  readonly setup: number;
  readonly mainAgent: number;
}

const INTEGRATION_HEADER = "\uF47F";
const COLUMN_GAPS_WIDTH = 8;
const MIN_NOTE_WIDTH = 4;

function wideTopicColumns(
  state: DashboardViewState,
  snapshot: WorkSnapshot,
  topics: readonly DurableTopic[],
  width: number,
): TopicColumns | undefined {
  if (state.sidebarOpen) return undefined;
  const integration = visibleWidth(INTEGRATION_HEADER);
  const name = columnWidth(
    "TOPIC",
    topics.map((topic) => topicDisplayName(topic, topics)),
  );
  const repository = columnWidth(
    "REPOSITORY",
    topics.map((topic) => topic.repository),
  );
  const pullRequest = columnWidth(
    "PR",
    topics.map((topic) => pullRequestCell(snapshot, topic.id)),
  );
  const setup = columnWidth(
    "SETUP",
    topics.map((topic) => setupCell(state, snapshot, topic)),
  );
  const mainAgent = columnWidth(
    "MAIN AGENT",
    topics.map((topic) =>
      renderListActivity(topicObservation(snapshot, topic.id)?.mainAgentActivity ?? "stopped", 0),
    ),
  );
  const fixedWidth =
    COLUMN_GAPS_WIDTH + integration + name + repository + pullRequest + setup + mainAgent;
  const note = width - fixedWidth;
  if (note < MIN_NOTE_WIDTH) return undefined;
  return { integration, name, note, repository, pullRequest, setup, mainAgent };
}

function columnWidth(header: string, values: readonly string[]): number {
  return Math.max(visibleWidth(header), ...values.map((value) => visibleWidth(value)));
}

function renderWideHeader(columns: TopicColumns): string {
  return `  ${pad(INTEGRATION_HEADER, columns.integration)} ${pad("TOPIC", columns.name)} ${pad("NOTE", columns.note)} ${pad("REPOSITORY", columns.repository)} ${pad("PR", columns.pullRequest)} ${pad("SETUP", columns.setup)} ${pad("MAIN AGENT", columns.mainAgent)}`;
}

function topicDisplayName(topic: DurableTopic, topics: readonly DurableTopic[]): string {
  if (topic.parentTopicId === undefined) return topic.name;
  return `${isLastChild(topic, topics) ? "└─ " : "├─ "}${topic.name}`;
}

function setupCell(state: DashboardViewState, snapshot: WorkSnapshot, topic: DurableTopic): string {
  const observation = topicObservation(snapshot, topic.id);
  if (observation?.orphan) return brightRed("orphan");
  if (
    observation?.gitOperationState !== undefined &&
    observation.gitOperationState !== "none" &&
    observation.gitOperationState !== "unknown"
  ) {
    const detail = observation.gitOperationConflict ? "conflict" : "pending";
    return brightRed(`${observation.gitOperationState} ${detail}`);
  }
  const activeAction = snapshot.observed.activeActions.find((item) => item.topicId === topic.id);
  if (activeAction !== undefined) return yellow(activeAction.kind.replace("topic.", ""));
  const operation = latestTopicOperation(snapshot, topic.id);
  if (
    operation !== undefined &&
    (operation.state === "accepted" ||
      operation.state === "awaiting-confirmation" ||
      operation.state === "running")
  )
    return yellow(`${operation.state} ${operation.phase}`);
  if (topic.setup.state === "ready") return "";
  if (topic.setup.state === "provisioning") return yellow("provisioning");
  if (topic.setup.state === "setup-interrupted") return brightRed("Interrupted Setup");
  return red(topic.setup.state);
}

function pullRequestCell(snapshot: WorkSnapshot, topicId: TopicId): string {
  const topic = snapshot.durable.topics.find((entry) => entry.topic.id === topicId)?.topic;
  const pullRequest = snapshot.observed.pullRequests.find(
    (entry) => entry.topicId === topicId,
  )?.value;
  const number = pullRequest?.identity.number ?? topic?.pullRequest?.number;
  if (number === undefined || topic === undefined) return "";
  const url = pullRequest?.url ?? `https://github.com/${topic.repository}/pull/${number}`;
  const link = underlinedHyperlink(`#${number}`, url);
  if (pullRequest === undefined) return link;
  const status = pullRequestStatus(pullRequest);
  return `${link} ${status === "ready" ? purple(status) : status}`;
}

function renderDetails(
  state: DashboardViewState,
  snapshot: WorkSnapshot,
  width: number,
  height: number,
): string[] {
  const topic = selectedTopic(state, orderedTopics(snapshot));
  if (topic === undefined) return ["Topic details"];
  const observationEntry = snapshot.observed.topics.find((entry) => entry.topicId === topic.id);
  const observation = observationEntry?.value;
  const pullRequestEntry = snapshot.observed.pullRequests.find(
    (entry) => entry.topicId === topic.id,
  );
  const pullRequest = pullRequestEntry?.value;
  const pullRequestNumber = pullRequest?.identity.number ?? topic.pullRequest?.number;
  const pullRequestUrl =
    pullRequest?.url ??
    (pullRequestNumber === undefined
      ? undefined
      : `https://github.com/${topic.repository}/pull/${pullRequestNumber}`);
  const setupOperation = snapshot.durable.operations
    .filter(
      (operation) => operation.topicId === topic.id && operation.input.kind === "topic.provision",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const setupDetail =
    setupOperation === undefined
      ? undefined
      : `${setupResultLabel(setupOperation.state)} · ${setupOperation.phase}`;
  const operation = latestTopicOperation(snapshot, topic.id);
  const activeAction = snapshot.observed.activeActions.find((item) => item.topicId === topic.id);
  const diagnostic =
    topic.setup.reason ??
    (observationEntry?.freshness._tag === "Failed"
      ? observationEntry.freshness.message
      : snapshot.observed.diagnostics.find((item) => item.topicId === topic.id)?.message);
  const gitDetail =
    observation?.gitOperationState !== undefined &&
    observation.gitOperationState !== "none" &&
    observation.gitOperationState !== "unknown"
      ? `${observation.gitOperationState} ${observation.gitOperationConflict ? "conflict" : "pending"}`
      : (observation?.gitOperationState ?? "unknown");
  const status = observation?.integrationStatus ?? { kind: "unknown" as const };
  const repositoryState = snapshot.durable.repositoryStates.find(
    (item) => item.repository === topic.repository,
  );
  const integrationBranch =
    repositoryState?.integrationBranch ?? repositoryState?.inferredIntegrationBranch;
  const integrationBranchSource =
    repositoryState?.source ??
    (repositoryState?.inferredIntegrationBranch === undefined ? "unknown" : "inferred");
  const targetSpec = topic.integrationTarget;
  const target =
    status.target ??
    (targetSpec?.kind === "topic"
      ? (orderedTopics(snapshot).find((item) => item.id === targetSpec.topicId)?.branch ??
        "Unknown Topic Branch")
      : (integrationBranch ?? "Unknown Integration Branch"));
  const integrationParts: string[] = [status.kind];
  if (status.ahead !== undefined) integrationParts.push(`ahead ${status.ahead}`);
  if (status.behind !== undefined) integrationParts.push(`behind ${status.behind}`);
  if (topic.chainState === "pending") integrationParts.push("pending insertion");
  const lines = [
    bright(topic.name),
    "",
    `Repository: ${topic.repository}`,
    `Branch: ${topic.branch}`,
    `Base checkout: ${observation?.baseCheckout ?? "not observable"}`,
    `Worktree: ${observation?.orphan ? "missing · orphan" : (topic.worktreePath ?? "not ready")}`,
    `Workspace: ${observation?.workspace ?? "not observable"}`,
    `Partition: ${topic.partition + 1}`,
    `Setup: ${topic.setup.state === "setup-interrupted" ? "Interrupted Setup" : topic.setup.state}`,
    ...(setupDetail === undefined ? [] : [`Setup operation: ${setupDetail}`]),
    ...(operation === undefined
      ? []
      : [`Operation: ${setupResultLabel(operation.state)} · ${operation.phase}`]),
    ...(activeAction === undefined ? [] : [`Active command: ${activeAction.kind}`]),
    `Observation: ${freshnessLabel(observationEntry?.freshness)}`,
    `Main Agent: ${renderMainAgentActivity(
      observation?.mainAgentActivity ?? "stopped",
      state.shimmerPhase,
    )}`,
    `Integration: ${integrationParts.join(" · ")}`,
    `Integration Target: ${target}`,
    `Integration Branch: ${integrationBranch ?? "unknown"} (${integrationBranchSource})`,
    ...(status.diagnostic === undefined ? [] : [`Integration detail: ${status.diagnostic}`]),
    `Git operation: ${gitDetail === "none" ? "none" : brightRed(gitDetail)}`,
    ...(diagnostic === undefined ? [] : [`Diagnostic: ${diagnostic}`]),
    ...(pullRequestNumber === undefined || pullRequestUrl === undefined
      ? []
      : [
          `Pull Request: ${underlinedHyperlink(`#${pullRequestNumber}`, pullRequestUrl)}${pullRequest === undefined ? "" : ` ${pullRequestStatus(pullRequest)}`}`,
          ...(pullRequest === undefined
            ? []
            : [
                `PR lifecycle: ${pullRequest.state}${pullRequest.draft ? " · draft" : ""}`,
                `PR CI: ${pullRequest.ci}`,
                `PR review: ${reviewState(pullRequest)}`,
              ]),
          ...(pullRequestEntry?.freshness._tag === "Failed"
            ? [`PR diagnostic: ${pullRequestEntry.freshness.message}`]
            : []),
        ]),
    topic.note === undefined ? "Note: —" : `Note: ${renderTopicNote(topic.note)}`,
    "",
    state.focus === "actions" ? bright("Actions") : "Actions",
  ];
  const actions = topicActions(state, snapshot);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const marker = state.focus === "actions" && index === state.focusedAction ? ">" : " ";
    const feedback =
      state.actionFeedback?.topicId === topic.id &&
      state.actionFeedback.action === action.action._tag
        ? state.actionFeedback
        : undefined;
    const suffix =
      feedback === undefined
        ? action.available
          ? ""
          : dim(` · ${action.reason ?? "unavailable"}`)
        : ` · ${renderActionFeedback(feedback)}`;
    lines.push(`${marker} ${action.available ? action.label : dim(action.label)}${suffix}`);
  }
  lines.push("", "h/l focus · j/k action · Enter run · q close details · esc quit");
  return lines.slice(0, height).map((line) => truncateToWidth(line, width));
}

function renderActionFeedback(feedback: DashboardActionFeedback): string {
  if (feedback.status === "success") return green(feedback.text);
  if (feedback.status === "failure") return red(feedback.text);
  return yellow(feedback.text);
}

function latestTopicOperation(snapshot: WorkSnapshot, topicId: TopicId) {
  return snapshot.durable.operations
    .filter((operation) => operation.topicId === topicId)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function freshnessLabel(
  freshness: WorkSnapshot["observed"]["topics"][number]["freshness"] | undefined,
): string {
  if (freshness === undefined || freshness._tag === "Unknown") return "Unknown";
  if (freshness._tag === "Refreshing") return `Refreshing since ${freshness.startedAt}`;
  if (freshness._tag === "Fresh") return `Observed ${freshness.observedAt}`;
  return `Observation failed ${freshness.failedAt}: ${freshness.message}`;
}

function setupResultLabel(state: string): string {
  if (state === "succeeded") return "completed";
  if (state === "setup-interrupted") return "interrupted";
  return state;
}

function renderEditor(editor: DashboardEditor, width: number, inputLine?: string): string[] {
  const title = editor.kind === "rename" ? "Rename Topic" : "Edit Topic Note";
  return [
    bright(title),
    "",
    truncateToWidth(inputLine ?? `> ${editor.value}█`, width),
    editor.error === undefined ? "" : red(editor.error),
    "",
    "Enter save · Escape cancel",
  ];
}

function renderConfirmation(confirmation: DashboardConfirmation, width: number): string[] {
  return [
    bright("Confirm Work action"),
    "",
    truncateToWidth(confirmation.text, width),
    "",
    "y/Enter confirm · n/Escape cancel",
  ];
}

function orderedTopics(snapshot: WorkSnapshot | undefined): DurableTopic[] {
  const topics = (snapshot?.durable.topics ?? []).map((entry) => entry.topic);
  const observations = new Map(
    snapshot?.observed.topics.map((item) => [item.topicId, item.value]) ?? [],
  );
  const active = (topic: DurableTopic): boolean => {
    const activity = observations.get(topic.id)?.mainAgentActivity;
    return activity !== undefined && activity !== "stopped" && activity !== "failed";
  };
  const roots = topics.filter((topic) => topic.parentTopicId === undefined);
  roots.sort((left, right) => {
    if (left.partition !== right.partition) return left.partition - right.partition;
    const leftActive =
      active(left) || topics.some((item) => item.parentTopicId === left.id && active(item));
    const rightActive =
      active(right) || topics.some((item) => item.parentTopicId === right.id && active(item));
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return compareTopics(left, right);
  });
  const ordered: DurableTopic[] = [];
  for (const root of roots) {
    ordered.push(root);
    ordered.push(...displayChildOrder(topics.filter((topic) => topic.parentTopicId === root.id)));
  }
  return ordered;
}

function compareTopics(left: DurableTopic, right: DurableTopic): number {
  return (
    left.name.localeCompare(right.name) ||
    left.repository.localeCompare(right.repository) ||
    left.id.localeCompare(right.id)
  );
}

/** Selects the row that takes the deleted row's place, or the previous final row. */
export function selectionAfterTopicDeletion(
  snapshot: WorkSnapshot | undefined,
  deletedTopicId: TopicId,
): TopicId | undefined {
  const topics = orderedTopics(snapshot);
  const deletedIndex = topics.findIndex((topic) => topic.id === deletedTopicId);
  if (deletedIndex < 0) return undefined;
  return topics[deletedIndex + 1]?.id ?? topics[deletedIndex - 1]?.id;
}

function topicObservation(snapshot: WorkSnapshot | undefined, topicId: TopicId) {
  return snapshot?.observed.topics.find((entry) => entry.topicId === topicId)?.value;
}

function selectedTopic(
  state: DashboardViewState,
  topics: readonly DurableTopic[],
): DurableTopic | undefined {
  return topics.find((topic) => topic.id === state.selectedTopicId);
}

function moveSelection(
  state: DashboardViewState,
  topics: readonly DurableTopic[],
  delta: number,
): DashboardViewState {
  const index = Math.max(
    0,
    topics.findIndex((topic) => topic.id === state.selectedTopicId),
  );
  const next = Math.max(0, Math.min(topics.length - 1, index + delta));
  return {
    ...state,
    selectedTopicId: topics[next]!.id,
    selectionIndex: next,
    focusedAction: 0,
  };
}

function moveAction(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  delta: number,
): DashboardInputResult {
  const actions = topicActions(state, snapshot);
  if (actions.length === 0) return { state };
  const focusedAction = Math.max(0, Math.min(actions.length - 1, state.focusedAction + delta));
  return { state: { ...state, focusedAction } };
}

function firstAvailableAction(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
): number {
  const index = topicActions(state, snapshot).findIndex((action) => action.available);
  return Math.max(0, index);
}

function actionResult(state: DashboardViewState, action: DashboardAction): DashboardInputResult {
  return { state, action };
}

function withoutEditor(state: DashboardViewState): DashboardViewState {
  const { editor: _editor, ...rest } = state;
  return rest;
}

function withoutConfirmation(state: DashboardViewState): DashboardViewState {
  const { confirmation: _confirmation, ...rest } = state;
  return rest;
}

function isLastChild(topic: DurableTopic, topics: readonly DurableTopic[]): boolean {
  if (topic.parentTopicId === undefined) return false;
  const children = topics.filter((item) => item.parentTopicId === topic.parentTopicId);
  return children.at(-1)?.id === topic.id;
}

function renderListActivity(activity: MainAgentActivity, phase: number): string {
  if (activity === "stopped") return "";
  const rendered = renderMainAgentActivity(activity, phase);
  if (activity === "idle") return dim(rendered);
  if (activity === "waiting-for-human") return yellow(rendered);
  return rendered;
}

function integrationGlyph(status: "current" | "behind" | "conflict" | "unknown"): string {
  if (status === "current") return green("\uF058");
  if (status === "behind") return yellow("\uF063");
  if (status === "conflict") return red("\uF071");
  return dim("\uF059");
}

function fit(lines: readonly string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, height).map((line) => truncateToWidth(line, width));
  while (fitted.length < height) fitted.push("");
  return fitted;
}
function pad(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
const SGR_RESET = "\x1b[0m";

function reopenAfterReset(value: string, open: string): string {
  return value.split(SGR_RESET).join(`${SGR_RESET}${open}`);
}

function highlight(value: string, width: number): string {
  const open = "\x1b[48;2;59;66;82m";
  const truncated = truncateToWidth(value, width);
  const highlighted = reopenAfterReset(truncated, open);
  const padded = `${highlighted}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
  return `${open}${padded}\x1b[49m`;
}
function isInactive(activity: MainAgentActivity | undefined): boolean {
  return activity === undefined || activity === "stopped" || activity === "failed";
}
function dimIfInactive(value: string, activity: MainAgentActivity | undefined): string {
  return isInactive(activity) ? dim(value) : value;
}
function dim(value: string): string {
  const open = "\x1b[2m";
  return `${open}${reopenAfterReset(value, open)}\x1b[22m`;
}
const LAUNCHPAD_NOTE = /(^|[^A-Za-z0-9_])LAUNCHPAD(?=$|[^A-Za-z0-9_])/;

function renderTopicNote(
  note: string,
  context: {
    readonly selected?: boolean;
    readonly orphan?: boolean;
    readonly inactive?: boolean;
  } = {},
): string {
  if (!LAUNCHPAD_NOTE.test(note)) return yellow(note);
  const restore =
    `${context.selected === true ? "\x1b[48;2;59;66;82m" : ""}` +
    `${context.orphan === true ? "\x1b[91m" : ""}` +
    `${context.inactive === true ? "\x1b[2m" : ""}`;
  return `\x1b[22m\x1b[48;2;235;203;139m\x1b[38;2;46;52;64m\x1b[1m${note}\x1b[22m\x1b[39m\x1b[49m${restore}`;
}

function underlinedHyperlink(label: string, url: string): string {
  return `\x1b[4m\x1b]8;;${url}\x07${label}\x1b]8;;\x07\x1b[24m`;
}

function reviewState(value: PullRequestObservation): string {
  const status = pullRequestStatus(value);
  if (status === "feedback") {
    const reasons = [
      ...(value.changesRequested ? ["changes requested"] : []),
      ...(value.unresolvedThreads > 0
        ? [
            `${value.unresolvedThreads} unresolved thread${value.unresolvedThreads === 1 ? "" : "s"}`,
          ]
        : []),
    ];
    return reasons.join(" · ");
  }
  return status;
}
function bright(value: string): string {
  return `\x1b[1m${value}\x1b[22m`;
}
function yellow(value: string): string {
  return `\x1b[33m${value}\x1b[39m`;
}
function green(value: string): string {
  return `\x1b[32m${value}\x1b[39m`;
}
function red(value: string): string {
  return `\x1b[31m${value}\x1b[39m`;
}
function purple(value: string): string {
  return `\x1b[35m${value}\x1b[39m`;
}
function brightRed(value: string): string {
  return `\x1b[91m${value}\x1b[39m`;
}
