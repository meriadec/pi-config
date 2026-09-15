import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { WorkSnapshot } from "../application/state/index.ts";
import type { DurableTopic, MainAgentActivity, TopicId } from "../domain/index.ts";

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
  readonly text: string;
};
export type DashboardAction =
  | { readonly _tag: "CopyBranch"; readonly topicId: TopicId; readonly branch: string }
  | { readonly _tag: "OpenWorkspace"; readonly topicId: TopicId }
  | { readonly _tag: "OpenTerminal"; readonly topicId: TopicId }
  | { readonly _tag: "OpenMainAgent"; readonly topicId: TopicId }
  | { readonly _tag: "ResetMainAgent"; readonly topicId: TopicId }
  | { readonly _tag: "OpenPullRequest"; readonly topicId: TopicId }
  | { readonly _tag: "Rebase"; readonly topicId: TopicId }
  | { readonly _tag: "Rename"; readonly topicId: TopicId; readonly name: string }
  | { readonly _tag: "SetNote"; readonly topicId: TopicId; readonly note: string }
  | { readonly _tag: "MovePartition"; readonly topicId: TopicId; readonly direction: "up" | "down" }
  | { readonly _tag: "Delete"; readonly topicId: TopicId };

export interface DashboardViewState {
  readonly selectedTopicId?: TopicId;
  readonly sidebarOpen: boolean;
  readonly focus: DashboardFocus;
  readonly focusedAction: number;
  readonly shimmerPhase: number;
  readonly editor?: DashboardEditor;
  readonly confirmation?: DashboardConfirmation;
  readonly message?: string;
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
  pending: new Set(),
});

export function reconcileDashboardSelection(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
): DashboardViewState {
  const topics = orderedTopics(snapshot);
  if (topics.length === 0) {
    const { selectedTopicId: _selected, ...rest } = state;
    return { ...rest, sidebarOpen: false, focus: "list", focusedAction: 0 };
  }
  if (topics.some((topic) => topic.id === state.selectedTopicId)) return state;
  return { ...state, selectedTopicId: topics[0]!.id };
}

export function handleDashboardViewInput(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  data: string,
): DashboardInputResult {
  const topics = orderedTopics(snapshot);
  if (state.confirmation !== undefined) {
    if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
      return {
        state: withoutConfirmation(state),
        action: state.confirmation.action,
      };
    }
    if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
      return { state: withoutConfirmation(state) };
    }
    return { state };
  }
  if (state.editor !== undefined) {
    if (matchesKey(data, Key.escape)) return { state: withoutEditor(state) };
    if (matchesKey(data, Key.enter)) {
      const value = state.editor.value.trim();
      if (state.editor.kind === "rename" && value.length === 0) {
        return {
          state: { ...state, editor: { ...state.editor, error: "Topic name must not be empty." } },
        };
      }
      if (value.length > 200) {
        return {
          state: {
            ...state,
            editor: { ...state.editor, error: "The value must not exceed 200 characters." },
          },
        };
      }
      return {
        state: withoutEditor(state),
        action:
          state.editor.kind === "rename"
            ? { _tag: "Rename", topicId: state.editor.topicId, name: value }
            : { _tag: "SetNote", topicId: state.editor.topicId, note: value },
      };
    }
    const current = state.editor.value;
    const value =
      matchesKey(data, Key.backspace) || data === "\x7f"
        ? [...current].slice(0, -1).join("")
        : isPrintable(data)
          ? `${current}${data.replace(/[\r\n\u2028\u2029]/g, " ")}`
          : current;
    const { error: _error, ...editor } = state.editor;
    return { state: { ...state, editor: { ...editor, value } } };
  }
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
    if (state.sidebarOpen) {
      return { state: { ...state, sidebarOpen: false, focus: "list", focusedAction: 0 } };
    }
    return { state, exit: true };
  }
  if (topics.length === 0) return { state };
  const selected = selectedTopic(state, topics) ?? topics[0]!;
  if (data === "J")
    return actionResult(state, { _tag: "MovePartition", topicId: selected.id, direction: "down" });
  if (data === "K")
    return actionResult(state, { _tag: "MovePartition", topicId: selected.id, direction: "up" });
  if (data === "n")
    return {
      state: {
        ...state,
        editor: { kind: "note", topicId: selected.id, value: selected.note ?? "" },
      },
    };
  if (data === "s") return actionResult(state, { _tag: "Rebase", topicId: selected.id });
  if (data === "m") return actionResult(state, { _tag: "OpenMainAgent", topicId: selected.id });
  if (data === "o") return actionResult(state, { _tag: "OpenWorkspace", topicId: selected.id });
  if (matchesKey(data, Key.down) || data === "j") {
    if (state.focus === "actions") return moveAction(state, snapshot, 1);
    return { state: moveSelection(state, topics, 1) };
  }
  if (matchesKey(data, Key.up) || data === "k") {
    if (state.focus === "actions") return moveAction(state, snapshot, -1);
    return { state: moveSelection(state, topics, -1) };
  }
  if (matchesKey(data, Key.right) || data === "l") {
    if (!state.sidebarOpen) return { state: { ...state, sidebarOpen: true, focus: "detail" } };
    return {
      state: { ...state, focus: "actions", focusedAction: firstAvailableAction(state, snapshot) },
    };
  }
  if (matchesKey(data, Key.left) || data === "h") {
    if (state.focus === "actions") return { state: { ...state, focus: "detail" } };
    if (state.sidebarOpen) return { state: { ...state, sidebarOpen: false, focus: "list" } };
    return { state };
  }
  if (matchesKey(data, Key.enter)) {
    if (!state.sidebarOpen) return { state: { ...state, sidebarOpen: true, focus: "detail" } };
    if (state.focus === "detail")
      return {
        state: { ...state, focus: "actions", focusedAction: firstAvailableAction(state, snapshot) },
      };
    const action = topicActions(state, snapshot)[state.focusedAction];
    if (action === undefined || !action.available) return { state };
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
    if (action.action._tag === "Delete" || action.action._tag === "ResetMainAgent") {
      return {
        state: {
          ...state,
          confirmation: {
            action: action.action,
            text:
              action.action._tag === "Delete"
                ? `Delete Topic ${selected.name}? The Branch and Worktree are not deleted.`
                : `Start a new Main Agent for ${selected.name}?`,
          },
        },
      };
    }
    return actionResult(state, action.action);
  }
  return { state };
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
  const observation = topicObservation(snapshot, topic.id);
  const pullRequest = snapshot?.observed.pullRequests.find(
    (entry) => entry.topicId === topic.id,
  )?.value;
  const ready = topic.setup.state === "ready" && topic.worktreePath !== null;
  const behind = observation?.integrationStatus === "behind";
  const busy = state.pending.has(topic.id);
  const item = (
    label: string,
    action: DashboardAction,
    available = true,
    reason?: string,
  ): TopicActionView => ({
    label,
    action,
    available: available && !busy,
    ...(reason === undefined ? {} : { reason }),
  });
  return [
    item("Copy Branch Name", { _tag: "CopyBranch", topicId: topic.id, branch: topic.branch }),
    item(
      "Open Topic Workspace",
      { _tag: "OpenWorkspace", topicId: topic.id },
      ready,
      "Worktree unavailable",
    ),
    item(
      "Open Terminal",
      { _tag: "OpenTerminal", topicId: topic.id },
      ready,
      "Worktree unavailable",
    ),
    item(
      "Open Main Agent",
      { _tag: "OpenMainAgent", topicId: topic.id },
      ready,
      "Worktree unavailable",
    ),
    item(
      "Start New Main Agent",
      { _tag: "ResetMainAgent", topicId: topic.id },
      ready,
      "Worktree unavailable",
    ),
    item(
      "Open Pull Request",
      { _tag: "OpenPullRequest", topicId: topic.id },
      pullRequest !== undefined,
      "No pull request",
    ),
    item(
      "Rebase onto Integration Target",
      { _tag: "Rebase", topicId: topic.id },
      behind,
      "Topic is not Behind",
    ),
    item("Rename Topic", { _tag: "Rename", topicId: topic.id, name: topic.name }),
    item(topic.note === undefined ? "Add Note" : "Edit Note", {
      _tag: "SetNote",
      topicId: topic.id,
      note: topic.note ?? "",
    }),
    item("Delete Topic", { _tag: "Delete", topicId: topic.id }),
  ];
}

export function renderDashboardView(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  width: number,
  height: number,
  phaseMessage?: string,
): string[] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  if (state.editor !== undefined)
    return fit(renderEditor(state.editor, safeWidth), safeWidth, safeHeight);
  if (state.confirmation !== undefined)
    return fit(renderConfirmation(state.confirmation, safeWidth), safeWidth, safeHeight);
  if (snapshot === undefined)
    return fit(
      ["Work", "", phaseMessage ?? "Loading Work state…", "", "q close"],
      safeWidth,
      safeHeight,
    );
  const stateWithSelection = reconcileDashboardSelection(state, snapshot);
  const topics = orderedTopics(snapshot);
  if (topics.length === 0) {
    return fit(["Work", "", "No Topics.", "", "r refresh · q close"], safeWidth, safeHeight);
  }
  const sidebarWidth =
    stateWithSelection.sidebarOpen && safeWidth >= 72
      ? Math.min(54, Math.floor(safeWidth * 0.46))
      : 0;
  const listWidth = sidebarWidth === 0 ? safeWidth : safeWidth - sidebarWidth - 1;
  const list = renderList(stateWithSelection, snapshot, topics, listWidth, safeHeight);
  if (!stateWithSelection.sidebarOpen) return fit(list, safeWidth, safeHeight);
  const side = renderDetails(
    stateWithSelection,
    snapshot,
    sidebarWidth === 0 ? safeWidth : sidebarWidth,
    safeHeight,
  );
  if (sidebarWidth === 0) return fit(side, safeWidth, safeHeight);
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
): string[] {
  const lines = [
    bright("Work"),
    dim("  Topic                         Setup          Agent          PR   ↳"),
  ];
  let previousPartition: number | undefined;
  for (const topic of topics) {
    if (previousPartition !== undefined && topic.partition !== previousPartition) lines.push("");
    previousPartition = topic.partition;
    const selected = topic.id === state.selectedTopicId;
    const observation = topicObservation(snapshot, topic.id);
    const pullRequest = snapshot.observed.pullRequests.find(
      (entry) => entry.topicId === topic.id,
    )?.value;
    const prefix =
      topic.parentTopicId === undefined ? "" : isLastChild(topic, topics) ? "└─ " : "├─ ";
    const name = truncateToWidth(`${prefix}${topic.name}`, Math.max(8, width - 42));
    const setup =
      topic.setup.state === "ready"
        ? green("ready")
        : topic.setup.state === "provisioning"
          ? yellow("provisioning")
          : red(topic.setup.state.replace("setup-", ""));
    const activity = renderActivity(
      observation?.mainAgentActivity ?? "stopped",
      state.shimmerPhase,
    );
    const pr =
      pullRequest === undefined
        ? "—"
        : pullRequest.state === "open"
          ? pullRequest.ci === "failing"
            ? red("●")
            : green("●")
          : pullRequest.state;
    const integration = integrationGlyph(observation?.integrationStatus ?? "unknown");
    const row = `  ${pad(name, Math.max(8, width - 42))}  ${pad(setup, 14)} ${pad(activity, 14)} ${pad(pr, 4)} ${integration}`;
    lines.push(
      selected
        ? highlight(row, width)
        : observation?.orphan
          ? brightRed(row)
          : dimIfInactive(row, observation?.mainAgentActivity),
    );
    if (lines.length >= height - 2) break;
  }
  lines.push(
    state.message ?? "",
    "j/k select · l/Enter details · J/K move Partition · n note · s rebase · m agent · o workspace · r refresh · q close",
  );
  return lines;
}

function renderDetails(
  state: DashboardViewState,
  snapshot: WorkSnapshot,
  width: number,
  height: number,
): string[] {
  const topic = selectedTopic(state, orderedTopics(snapshot));
  if (topic === undefined) return ["Topic details"];
  const observation = topicObservation(snapshot, topic.id);
  const pullRequest = snapshot.observed.pullRequests.find(
    (entry) => entry.topicId === topic.id,
  )?.value;
  const integrationTarget = topic.integrationTarget;
  const target =
    integrationTarget?.kind === "topic"
      ? (orderedTopics(snapshot).find((item) => item.id === integrationTarget.topicId)?.name ??
        "Unknown Topic")
      : "Integration Branch";
  const lines = [
    bright(topic.name),
    "",
    `Repository: ${topic.repository}`,
    `Branch: ${topic.branch}`,
    `Partition: ${topic.partition + 1}`,
    `Setup: ${topic.setup.state}`,
    `Main Agent: ${observation?.mainAgentActivity ?? "stopped"}`,
    `Integration: ${observation?.integrationStatus ?? "unknown"}`,
    `Target: ${target}`,
    `Git: ${observation?.gitOperationState ?? "unknown"}`,
    `Worktree: ${observation?.orphan ? "missing" : (topic.worktreePath ?? "not ready")}`,
    `Pull Request: ${pullRequest === undefined ? "none" : `#${pullRequest.identity.number} ${pullRequest.state} · CI ${pullRequest.ci}`}`,
    topic.note === undefined ? "Note: —" : `Note: ${topic.note}`,
    "",
    state.focus === "actions" ? bright("Actions") : "Actions",
  ];
  const actions = topicActions(state, snapshot);
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const marker = state.focus === "actions" && index === state.focusedAction ? ">" : " ";
    const suffix = action.available ? "" : ` · ${action.reason ?? "unavailable"}`;
    lines.push(`${marker} ${action.available ? action.label : dim(action.label)}${dim(suffix)}`);
  }
  lines.push("", "h back · j/k action · Enter run");
  return lines.slice(0, height).map((line) => truncateToWidth(line, width));
}

function renderEditor(editor: DashboardEditor, width: number): string[] {
  const title = editor.kind === "rename" ? "Rename Topic" : "Edit Topic Note";
  return [
    bright(title),
    "",
    truncateToWidth(`> ${editor.value}█`, width),
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
  return [...topics].sort((left, right) => {
    if (left.partition !== right.partition) return left.partition - right.partition;
    const leftRoot = left.parentTopicId ?? left.id;
    const rightRoot = right.parentTopicId ?? right.id;
    if (leftRoot !== rightRoot) return left.name.localeCompare(right.name);
    if (left.parentTopicId === undefined) return -1;
    if (right.parentTopicId === undefined) return 1;
    return left.name.localeCompare(right.name);
  });
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
  return { ...state, selectedTopicId: topics[next]!.id, focusedAction: 0 };
}

function moveAction(
  state: DashboardViewState,
  snapshot: WorkSnapshot | undefined,
  delta: number,
): DashboardInputResult {
  const actions = topicActions(state, snapshot);
  if (actions.length === 0) return { state };
  let index = state.focusedAction;
  for (let count = 0; count < actions.length; count += 1) {
    index = (index + delta + actions.length) % actions.length;
    if (actions[index]!.available) return { state: { ...state, focusedAction: index } };
  }
  return { state };
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

function renderActivity(activity: MainAgentActivity, phase: number): string {
  if (activity !== "thinking" && activity !== "thinking-sub" && activity !== "tracking-pr")
    return activity;
  const palette = phase % 3 === 0 ? "\x1b[95m" : phase % 3 === 1 ? "\x1b[94m" : "\x1b[96m";
  return `${palette}${activity}\x1b[39m`;
}

function integrationGlyph(status: "current" | "behind" | "conflict" | "unknown"): string {
  if (status === "current") return green("●");
  if (status === "behind") return yellow("↓");
  if (status === "conflict") return red("!");
  return dim("?");
}

function fit(lines: readonly string[], width: number, height: number): string[] {
  return lines.slice(0, height).map((line) => truncateToWidth(line, width));
}
function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}
function highlight(value: string, width: number): string {
  return `\x1b[7m${pad(truncateToWidth(value, width), width)}\x1b[27m`;
}
function dimIfInactive(value: string, activity: MainAgentActivity | undefined): string {
  return activity === undefined || activity === "stopped" || activity === "idle"
    ? dim(value)
    : value;
}
function dim(value: string): string {
  return `\x1b[2m${value}\x1b[22m`;
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
function brightRed(value: string): string {
  return `\x1b[91m${value}\x1b[39m`;
}
function isPrintable(value: string): boolean {
  return value.length > 0 && !value.startsWith("\x1b") && !["\r", "\n", "\t"].includes(value);
}
