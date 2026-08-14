import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  hyperlink,
  fuzzyFilter,
} from "@earendil-works/pi-tui";
import type { DaemonSnapshot, WorkEvent } from "../daemon/protocol.ts";
import type { MainAgentLease } from "../daemon/main-agent.ts";
import type { TopicOperation } from "../daemon/topic-service.ts";
import {
  isValidBranchName,
  parseRepository,
  pullRequestStatus,
  type MainAgentState,
  type PullRequestRef,
  type TopicManifest,
} from "../shared/domain.ts";
import type { TopicDiagnostic } from "../shared/topic-store.ts";

export type DashboardPhase = "loading" | "connected" | "reconnecting" | "failure";
export type DashboardFocus = "list" | "detail" | "actions";

export type TopicWizardStage = "name" | "branch" | "repository" | "review";

export interface TopicWizardState {
  stage: TopicWizardStage;
  name: string;
  branch: string;
  repository: string;
  /** Highlighted row in the Known repository completion list, or undefined when none is. */
  repositoryHighlight?: number;
  error?: string;
}

export interface DashboardConfirmation {
  token: string;
  action: string;
  text: string;
}

export interface TopicRenameState {
  topicId: string;
  name: string;
  error?: string;
}

export type TopicActionId =
  | "workspace"
  | "terminal"
  | "agent"
  | "reset-agent"
  | "pull-request"
  | "rename"
  | "retry"
  | "delete";

export interface DashboardState {
  phase: DashboardPhase;
  topics: readonly TopicManifest[];
  diagnostics: readonly TopicDiagnostic[];
  operations: readonly TopicOperation[];
  mainAgents: readonly MainAgentLease[];
  selectedTopicId?: string;
  sidebarOpen: boolean;
  focus: DashboardFocus;
  focusedAction: number;
  workspaces: Readonly<Record<string, number>>;
  baseCheckouts: Readonly<Record<string, string>>;
  /** Sorted `owner/repo` completions offered in the add-topic repository stage. */
  knownRepositories: readonly string[];
  pullRequests: Readonly<Record<string, PullRequestRef>>;
  unavailableActions: Readonly<Record<string, readonly TopicActionId[]>>;
  /** Animation cursor for the thinking-status shimmer. Advanced by a UI timer only. */
  shimmerPhase: number;
  wizard?: TopicWizardState;
  rename?: TopicRenameState;
  confirmation?: DashboardConfirmation;
  submissionInFlight?:
    | "create"
    | "retry"
    | "rename"
    | "confirm"
    | "reject"
    | "workspace"
    | "terminal"
    | "agent"
    | "reset-agent"
    | "pull-request"
    | "delete";
  message?: string;
}

export type DashboardViewModel =
  | { kind: "loading"; message: string }
  | { kind: "reconnecting"; message: string; topics: readonly TopicManifest[] }
  | { kind: "failure"; message: string }
  | {
      kind: "empty" | "connected";
      topics: readonly TopicManifest[];
      diagnostics: readonly TopicDiagnostic[];
      selectedTopicId?: string;
    };

export function initialDashboardState(): DashboardState {
  return {
    phase: "loading",
    topics: [],
    diagnostics: [],
    operations: [],
    mainAgents: [],
    sidebarOpen: false,
    focus: "list",
    focusedAction: 0,
    workspaces: {},
    baseCheckouts: {},
    knownRepositories: [],
    pullRequests: {},
    unavailableActions: {},
    shimmerPhase: 0,
  };
}

/** True while at least one Main Agent is thinking, so the shimmer timer must run. */
export function hasThinkingAgent(state: DashboardState): boolean {
  return state.mainAgents.some((agent) => agent.state === "thinking");
}

/** Advances the shimmer cursor by one step, wrapping to keep the number bounded. */
export function advanceShimmer(state: DashboardState): DashboardState {
  return { ...state, shimmerPhase: (state.shimmerPhase + 1) % SHIMMER_PERIOD };
}

export function dashboardViewModel(state: DashboardState): DashboardViewModel {
  if (state.phase === "loading") return { kind: "loading", message: "Loading Topics…" };
  if (state.phase === "reconnecting") {
    return {
      kind: "reconnecting",
      message: state.message ?? "Reconnecting to workd…",
      topics: state.topics,
    };
  }
  if (state.phase === "failure") {
    return {
      kind: "failure",
      message: state.message ?? "workd is unavailable.",
    };
  }
  const common = {
    topics: state.topics,
    diagnostics: state.diagnostics,
    ...(state.selectedTopicId === undefined ? {} : { selectedTopicId: state.selectedTopicId }),
  };
  return state.topics.length === 0
    ? { kind: "empty", ...common }
    : { kind: "connected", ...common };
}

export function hydrateDashboard(state: DashboardState, snapshot: DaemonSnapshot): DashboardState {
  const { message: _message, ...current } = state;
  return stabilizeSelection({
    ...current,
    phase: "connected",
    topics: sortTopics(snapshot.topics, snapshot.mainAgents),
    diagnostics: [...snapshot.diagnostics],
    operations: [...snapshot.operations],
    mainAgents: [...snapshot.mainAgents],
    baseCheckouts: { ...(snapshot.baseCheckouts ?? state.baseCheckouts) },
    knownRepositories: snapshot.knownRepositories
      ? [...snapshot.knownRepositories]
      : state.knownRepositories,
    pullRequests: { ...(snapshot.pullRequests ?? state.pullRequests) },
    unavailableActions: snapshot.deniedActions
      ? Object.fromEntries(
          Object.entries(snapshot.deniedActions).map(([topicId, actions]) => [
            topicId,
            actions.flatMap(policyActionToTopicAction),
          ]),
        )
      : state.unavailableActions,
  });
}

export function reduceDashboardEvent(state: DashboardState, event: WorkEvent): DashboardState {
  switch (event.type) {
    case "topic-added":
      return stabilizeSelection({
        ...state,
        phase: "connected",
        topics: sortTopics(upsert(state.topics, event.topic), state.mainAgents),
        selectedTopicId: event.topic.id,
      });
    case "setup-changed":
    case "topic-changed":
      return stabilizeSelection({
        ...state,
        phase: "connected",
        topics: sortTopics(upsert(state.topics, event.topic), state.mainAgents),
      });
    case "topic-removed": {
      const workspaces = { ...state.workspaces };
      const baseCheckouts = { ...state.baseCheckouts };
      const pullRequests = { ...state.pullRequests };
      const unavailableActions = { ...state.unavailableActions };
      delete workspaces[event.topicId];
      delete baseCheckouts[event.topicId];
      delete pullRequests[event.topicId];
      delete unavailableActions[event.topicId];
      return stabilizeSelection(
        {
          ...state,
          topics: state.topics.filter((topic) => topic.id !== event.topicId),
          workspaces,
          baseCheckouts,
          pullRequests,
          unavailableActions,
        },
        state.topics.findIndex((topic) => topic.id === event.topicId),
      );
    }
    case "diagnostic-added":
      return {
        ...state,
        diagnostics: upsertDiagnostic(state.diagnostics, event.diagnostic),
      };
    case "operation-changed":
      return {
        ...state,
        operations:
          event.operation === null
            ? state.operations.filter((operation) => operation.topicId !== event.topicId)
            : [
                ...state.operations.filter((operation) => operation.topicId !== event.topicId),
                event.operation,
              ],
      };
    case "main-agent-changed": {
      // Re-sort so a Topic bubbles up or sinks when its Main Agent starts or stops.
      const mainAgents = [
        ...state.mainAgents.filter((agent) => agent.topicId !== event.agent.topicId),
        event.agent,
      ];
      return {
        ...state,
        mainAgents,
        topics: sortTopics(state.topics, mainAgents),
      };
    }
    case "pull-request-changed": {
      const pullRequests = { ...state.pullRequests };
      if (event.pullRequest === null) delete pullRequests[event.topicId];
      else pullRequests[event.topicId] = event.pullRequest;
      return { ...state, pullRequests };
    }
    case "daemon-stopping":
      return {
        ...state,
        phase: "reconnecting",
        message: "workd stopped. Reconnecting…",
      };
    case "workspace-accessed":
    case "terminal-opened":
    case "main-agent-opened":
      return "workspace" in event.result
        ? {
            ...state,
            workspaces: {
              ...state.workspaces,
              [event.topicId]: event.result.workspace,
            },
          }
        : state;
    case "snapshot-changed":
      return state;
  }
}

export type DashboardAction =
  | {
      type: "create";
      input: { name: string; branch: string; repository: string };
    }
  | {
      type:
        | "retry"
        | "workspace"
        | "terminal"
        | "agent"
        | "reset-agent"
        | "pull-request"
        | "delete";
      topicId: string;
    }
  | { type: "rename"; topicId: string; name: string }
  | { type: "confirm"; token: string }
  | { type: "reject"; token: string };

export interface DashboardInputResult {
  state: DashboardState;
  exit: boolean;
  action?: DashboardAction;
  refresh?: boolean;
}

export function handleDashboardInput(state: DashboardState, data: string): DashboardInputResult {
  if (state.confirmation !== undefined) return handleConfirmationInput(state, data);
  if (state.rename !== undefined) return handleRenameInput(state, data);
  if (state.wizard !== undefined) return handleWizardInput(state, data);
  if ((data === "a" || data === "A") && state.submissionInFlight === undefined) {
    return {
      state: {
        ...state,
        sidebarOpen: false,
        focus: "list",
        wizard: { stage: "name", name: "", branch: "", repository: "" },
      },
      exit: false,
    };
  }
  if (data === "r" && state.submissionInFlight === undefined) {
    return { state, exit: false, refresh: true };
  }
  if (data === "m" && state.focus === "list" && state.submissionInFlight === undefined) {
    const action = topicActions(state).find((item) => item.id === "agent");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "o" && state.focus === "list" && state.submissionInFlight === undefined) {
    const action = topicActions(state).find((item) => item.id === "workspace");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "p" && state.focus === "list" && state.submissionInFlight === undefined) {
    const action = topicActions(state).find((item) => item.id === "pull-request");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "t" && state.focus === "list" && state.submissionInFlight === undefined) {
    const action = topicActions(state).find((item) => item.id === "terminal");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if ((data === "q" || data === "Q") && state.sidebarOpen) {
    return {
      state: { ...state, sidebarOpen: false, focus: "list" },
      exit: false,
    };
  }
  if (matchesKey(data, Key.escape)) return { state, exit: true };
  if (matchesKey(data, Key.down) || data === "j") {
    return state.focus === "actions" ? moveActionFocus(state, 1) : moveSelection(state, 1);
  }
  if (matchesKey(data, Key.up) || data === "k") {
    return state.focus === "actions" ? moveActionFocus(state, -1) : moveSelection(state, -1);
  }
  if (matchesKey(data, Key.right) || data === "l") return moveFocus(state, 1);
  if (matchesKey(data, Key.left) || data === "h") return moveFocus(state, -1);
  if (matchesKey(data, Key.enter) && state.selectedTopicId !== undefined) {
    if (state.focus === "actions" && state.submissionInFlight === undefined) {
      const action = topicActions(state)[state.focusedAction];
      if (action === undefined || action.unavailable) return { state, exit: false };
      if (action.id === "rename") return openRenamePrompt(state);
      return invokeTopicAction(state, action);
    }
    return openActionRail(state);
  }
  return { state, exit: false };
}

/** Makes a Git-safe default and keeps an initial ticket identity readable. */
export function defaultBranchForTopicName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .trim();
  const ticket = /^([A-Za-z]+-\d+)(?:\b|[_\s:—–-]+)/.exec(normalized)?.[1];
  const safe = normalized
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  if (safe.length === 0) return "";
  if (ticket === undefined) return safe.toLowerCase().slice(0, 200).replace(/-$/, "");
  const suffix = safe.slice(ticket.length).replace(/^-/, "").toLowerCase();
  return `${ticket.toUpperCase()}${suffix.length > 0 ? `-${suffix}` : ""}`
    .slice(0, 200)
    .replace(/-$/, "");
}

export function isValidRepositoryInput(repository: string): boolean {
  try {
    parseRepository(repository);
    return true;
  } catch {
    return false;
  }
}

function handleWizardInput(state: DashboardState, data: string): DashboardInputResult {
  const wizard = state.wizard!;
  if (matchesKey(data, Key.escape)) {
    const { wizard: _wizard, ...rest } = state;
    return {
      state: { ...rest, message: "Topic creation cancelled." },
      exit: false,
    };
  }
  if (matchesKey(data, Key.enter)) {
    if (wizard.stage === "name") {
      const name = wizard.name.trim();
      if (name.length === 0) return wizardError(state, "Topic name must not be empty.");
      const branch = defaultBranchForTopicName(name);
      if (branch.length === 0) return wizardError(state, "Topic name cannot make a safe branch.");
      return {
        state: {
          ...state,
          wizard: clearWizardError({
            ...wizard,
            stage: "repository",
            name,
            branch,
          }),
        },
        exit: false,
      };
    }
    if (wizard.stage === "repository") {
      const repository = wizard.repository.trim();
      if (!isValidRepositoryInput(repository)) {
        return wizardError(state, "Repository must have the exact owner/repo form.");
      }
      return {
        state: {
          ...state,
          wizard: clearWizardError({ ...wizard, stage: "branch", repository }),
        },
        exit: false,
      };
    }
    if (wizard.stage === "branch") {
      const branch = wizard.branch.trim();
      if (!isValidBranchName(branch))
        return wizardError(state, "Enter a valid non-empty Git branch name.");
      return {
        state: {
          ...state,
          wizard: clearWizardError({ ...wizard, stage: "review", branch }),
        },
        exit: false,
      };
    }
    if (state.submissionInFlight !== undefined) return { state, exit: false };
    const { wizard: _wizard, ...rest } = state;
    return {
      state: {
        ...rest,
        submissionInFlight: "create",
        message: `Creating ${wizard.repository} · ${wizard.branch}…`,
      },
      exit: false,
      action: {
        type: "create",
        input: {
          name: wizard.name,
          branch: wizard.branch,
          repository: wizard.repository,
        },
      },
    };
  }
  if (wizard.stage === "review") return { state, exit: false };
  const field = wizard.stage;
  const current = wizard[field];
  let next = current;
  if (matchesKey(data, Key.backspace) || data === "\x7f") next = [...current].slice(0, -1).join("");
  else if (isPrintableInput(data)) next += data;
  else return { state, exit: false };
  return {
    state: updateWizardField(state, next),
    exit: false,
  };
}

export function updateWizardField(state: DashboardState, value: string): DashboardState {
  const wizard = state.wizard;
  if (wizard === undefined || wizard.stage === "review") return state;
  const updated = clearWizardError({ ...wizard, [wizard.stage]: value });
  if (wizard.stage === "repository") {
    const highlight = defaultRepositoryHighlight(value, state.knownRepositories);
    if (highlight === undefined) delete updated.repositoryHighlight;
    else updated.repositoryHighlight = highlight;
  }
  return { ...state, wizard: updated };
}

/** Known repositories that fuzzy-match the current repository input (all of them when empty). */
export function filteredRepositories(
  repository: string,
  knownRepositories: readonly string[],
): readonly string[] {
  const query = repository.trim();
  if (query.length === 0) return knownRepositories;
  return fuzzyFilter([...knownRepositories], query, (entry) => entry);
}

// Empty input highlights nothing; any matching input highlights the best (top) match.
function defaultRepositoryHighlight(
  repository: string,
  knownRepositories: readonly string[],
): number | undefined {
  if (repository.trim().length === 0) return undefined;
  return filteredRepositories(repository, knownRepositories).length > 0 ? 0 : undefined;
}

/** Moves the completion highlight; down-arrow from no highlight lands on the first row. */
export function moveRepositoryHighlight(state: DashboardState, delta: number): DashboardState {
  const wizard = state.wizard;
  if (wizard === undefined || wizard.stage !== "repository") return state;
  const matches = filteredRepositories(wizard.repository, state.knownRepositories);
  if (matches.length === 0) return state;
  const base = wizard.repositoryHighlight ?? -1;
  const next = Math.max(0, Math.min(matches.length - 1, base + delta));
  return { ...state, wizard: { ...wizard, repositoryHighlight: next } };
}

/**
 * Writes the highlighted Known repository into the input, staying on the repository stage.
 * A no-op when nothing is highlighted. Returns the new input value so the caller can sync
 * its text widget.
 */
export function applyRepositoryCompletion(state: DashboardState): {
  state: DashboardState;
  value?: string;
} {
  const wizard = state.wizard;
  if (wizard === undefined || wizard.stage !== "repository") return { state };
  const highlight = wizard.repositoryHighlight;
  if (highlight === undefined) return { state };
  const matches = filteredRepositories(wizard.repository, state.knownRepositories);
  const chosen = matches[highlight];
  if (chosen === undefined) return { state };
  return {
    state: {
      ...state,
      wizard: clearWizardError({
        ...wizard,
        repository: chosen,
        repositoryHighlight: 0,
      }),
    },
    value: chosen,
  };
}

function openRenamePrompt(state: DashboardState): DashboardInputResult {
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  if (topic === undefined) return { state, exit: false };
  return {
    state: { ...state, rename: { topicId: topic.id, name: topic.name } },
    exit: false,
  };
}

function handleRenameInput(state: DashboardState, data: string): DashboardInputResult {
  const rename = state.rename!;
  if (matchesKey(data, Key.escape)) {
    const { rename: _rename, ...rest } = state;
    return { state: { ...rest, message: "Rename cancelled." }, exit: false };
  }
  if (matchesKey(data, Key.enter)) {
    if (state.submissionInFlight !== undefined) return { state, exit: false };
    const name = rename.name.trim();
    if (name.length === 0) {
      return {
        state: { ...state, rename: { ...rename, error: "Topic name must not be empty." } },
        exit: false,
      };
    }
    const topic = state.topics.find((item) => item.id === rename.topicId);
    if (topic !== undefined && topic.name === name) {
      const { rename: _rename, ...rest } = state;
      return { state: { ...rest, message: "Topic name is unchanged." }, exit: false };
    }
    const { rename: _rename, ...rest } = state;
    return {
      state: {
        ...rest,
        submissionInFlight: "rename",
        message: `Renaming Topic to ${name}…`,
      },
      exit: false,
      action: { type: "rename", topicId: rename.topicId, name },
    };
  }
  const current = rename.name;
  let next = current;
  if (matchesKey(data, Key.backspace) || data === "\x7f") next = [...current].slice(0, -1).join("");
  else if (isPrintableInput(data)) next += data;
  else return { state, exit: false };
  const { error: _error, ...withoutError } = rename;
  return { state: { ...state, rename: { ...withoutError, name: next } }, exit: false };
}

export function updateRenameField(state: DashboardState, value: string): DashboardState {
  const rename = state.rename;
  if (rename === undefined) return state;
  const { error: _error, ...withoutError } = rename;
  return { ...state, rename: { ...withoutError, name: value } };
}

function handleConfirmationInput(state: DashboardState, data: string): DashboardInputResult {
  if (state.submissionInFlight !== undefined) return { state, exit: false };
  const confirmation = state.confirmation!;
  if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
    return {
      state: {
        ...state,
        submissionInFlight: "confirm",
        message: `Confirming ${confirmation.action}…`,
      },
      exit: false,
      action: { type: "confirm", token: confirmation.token },
    };
  }
  if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
    return {
      state: {
        ...state,
        submissionInFlight: "reject",
        message: `Rejecting ${confirmation.action}…`,
      },
      exit: false,
      action: { type: "reject", token: confirmation.token },
    };
  }
  return { state, exit: false };
}

function wizardError(state: DashboardState, error: string): DashboardInputResult {
  return {
    state: { ...state, wizard: { ...state.wizard!, error } },
    exit: false,
  };
}

function clearWizardError(wizard: TopicWizardState): TopicWizardState {
  const { error: _error, ...rest } = wizard;
  return rest;
}

function isPrintableInput(data: string): boolean {
  return (
    data.length > 0 && !data.includes("\x1b") && [...data].every((character) => character >= " ")
  );
}

export interface DashboardLayout {
  wide: boolean;
  listWidth: number;
  sidebarWidth: number;
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

export function renderDashboard(
  state: DashboardState,
  width: number,
  height = 24,
  wizardInputLine?: string,
): string[] {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  if (state.wizard !== undefined) {
    return renderWizard(
      state.wizard,
      safeWidth,
      safeHeight,
      state.knownRepositories,
      wizardInputLine,
    );
  }
  if (state.rename !== undefined) {
    return renderRename(state.rename, safeWidth, safeHeight, wizardInputLine);
  }
  if (state.confirmation !== undefined) {
    return renderConfirmation(state.confirmation, safeWidth, safeHeight);
  }
  const layout = calculateDashboardLayout(safeWidth, state.sidebarOpen);
  const list = renderList(state, layout.listWidth, safeHeight);
  let lines: string[];
  if (state.sidebarOpen && layout.wide) {
    const sidebar = renderSidebar(state, layout.sidebarWidth, safeHeight);
    lines = Array.from({ length: Math.max(list.length, sidebar.length) }, (_, index) =>
      joinColumns(list[index] ?? "", sidebar[index] ?? "", layout.listWidth, safeWidth),
    );
  } else if (state.sidebarOpen) {
    lines = renderSidebar(state, safeWidth, safeHeight);
  } else {
    lines = list;
  }
  return fitLines(lines, safeWidth, safeHeight);
}

function renderList(state: DashboardState, width: number, height: number): string[] {
  const lines = [truncateToWidth("WORK · Topic control plane", width)];
  const view = dashboardViewModel(state);
  if (view.kind === "loading" || view.kind === "failure") {
    lines.push("", truncateToWidth(view.message, width));
  } else {
    if (view.kind === "reconnecting") lines.push(truncateToWidth(view.message, width));
    if (width >= 72) lines.push(renderWideHeader(width));
    else lines.push(truncateToWidth("  TOPIC · SETUP · MAIN AGENT", width));
    if (view.topics.length === 0) {
      lines.push("", truncateToWidth("No Topics yet.", width));
    } else {
      // Render only the visible window. A large Topic store must not create an unbounded frame.
      const capacity = Math.max(1, height - lines.length - 5);
      for (const topic of visibleTopics(view.topics, state.selectedTopicId, capacity)) {
        lines.push(renderTopicRow(state, topic, width));
      }
    }
    for (const diagnostic of state.diagnostics.slice(0, 3)) {
      lines.push(truncateToWidth(`! ${diagnostic.topicId}: ${diagnostic.message}`, width));
    }
  }
  const operation = state.operations.find((item) => item.topicId === state.selectedTopicId);
  const status = operation
    ? `${operation.kind}: ${operation.detail ?? operation.state}`
    : (state.message ?? `${state.topics.length} Topic${state.topics.length === 1 ? "" : "s"}`);
  while (lines.length < Math.max(1, height - 2)) lines.push("");
  lines.push(truncateToWidth(status, width));
  lines.push(
    truncateToWidth(
      "a Add · j/k or ↑/↓ move · enter actions · o workspace · t terminal · m Main Agent · p PR · r refresh · esc quit",
      width,
    ),
  );
  return lines;
}

function visibleTopics(
  topics: readonly TopicManifest[],
  selectedTopicId: string | undefined,
  capacity: number,
): readonly TopicManifest[] {
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
}

function renderWideHeader(width: number): string {
  const nameWidth = Math.max(12, Math.floor(width * 0.25));
  const repoWidth = Math.max(18, Math.floor(width * 0.3));
  return truncateToWidth(
    `  ${pad("TOPIC", nameWidth)} ${pad("REPOSITORY", repoWidth)} ${pad("PR", 18)} ${pad("SETUP", 14)} MAIN AGENT`,
    width,
  );
}

function renderTopicRow(state: DashboardState, topic: TopicManifest, width: number): string {
  const selected = topic.id === state.selectedTopicId;
  const prefix = selected ? (state.focus === "list" ? "> " : "* ") : "  ";
  const agent = state.mainAgents.find((item) => item.topicId === topic.id)?.state ?? "stopped";
  const inactive = !isMainAgentRunning(agent);
  // Dim only the status word for an idle Main Agent; the Topic stays active and bubbled up.
  // A Main Agent waiting for a human stands out in yellow.
  const agentCell =
    agent === "idle"
      ? dim(agent)
      : agent === "waiting-for-human"
        ? yellow(agent)
        : agent === "thinking"
          ? shimmer(agent, state.shimmerPhase)
          : agent;
  const pullRequest = state.pullRequests[topic.id];
  // A live Repository Recipe phase (setup N/M) replaces the durable setup state.
  // A settled "ready" Topic shows a blank cell; only intermediate states matter.
  const operationDetail = state.operations.find((item) => item.topicId === topic.id)?.detail;
  const setupState = topic.setup.state === "ready" ? "" : topic.setup.state;
  const setupCell = operationDetail ?? setupState;
  if (width < 72) {
    const link = pullRequest === undefined ? "" : ` · ${pullRequestCell(pullRequest)}`;
    const setupSegment = setupCell === "" ? "" : ` · ${setupCell}`;
    const row = truncateToWidth(
      `${prefix}${topic.name}${setupSegment} · ${agentCell}${link}`,
      width,
    );
    const styled = inactive ? dim(row) : row;
    return selected ? highlight(styled, width) : styled;
  }
  const nameWidth = Math.max(12, Math.floor(width * 0.25));
  const repoWidth = Math.max(18, Math.floor(width * 0.3));
  const row = truncateToWidth(
    `${prefix}${pad(topic.name, nameWidth)} ${pad(topic.repository, repoWidth)} ${pad(pullRequestCell(pullRequest), 18)} ${pad(setupCell, 14)} ${agentCell}`,
    width,
  );
  const styled = inactive ? dim(row) : row;
  return selected ? highlight(styled, width) : styled;
}

// truncateToWidth emits a full SGR reset (\x1b[0m) at truncation points (around the
// ellipsis), which cancels any ambient attribute wrapped around the line. Reopen the
// ambient sequence after every embedded reset so the style also covers the ellipsis
// and trailing padding.
const SGR_RESET = "\x1b[0m";
function reopenAfterReset(text: string, open: string): string {
  return text.split(SGR_RESET).join(SGR_RESET + open);
}

/** Wraps a fully truncated line in the terminal faint (dim) attribute. */
function dim(text: string): string {
  return `\x1b[2m${reopenAfterReset(text, "\x1b[2m")}\x1b[22m`;
}

// A subtle row highlight one shade lighter than the terminal background. The value is
// Nord1 (#3B4252, one step up from the Nord0 background), the palette's natural
// "current line" tint. The row is padded to the full list width first so the highlight
// spans the whole line, then closed with a background reset.
function highlight(row: string, width: number): string {
  const open = "\x1b[48;2;59;66;82m";
  const padded = reopenAfterReset(row, open) + " ".repeat(Math.max(0, width - visibleWidth(row)));
  return `${open}${padded}\x1b[49m`;
}

/** Colours a status word yellow. */
function yellow(text: string): string {
  return `\x1b[33m${text}\x1b[39m`;
}

/** Colours a status word a light violet. */
function purple(text: string): string {
  return `\x1b[38;5;183m${text}\x1b[39m`;
}

// A brightness ramp swept across the thinking word, brightest cell first.
const SHIMMER_BASE = "\x1b[38;5;146m";
const SHIMMER_COLORS = ["\x1b[38;5;231m", "\x1b[38;5;189m", "\x1b[38;5;183m"] as const;
// A trailing gap after the word so each sweep restarts with a clear pause.
const SHIMMER_TRAIL = 4;

// Only the "thinking" status shimmers, so the sweep period is its length plus the trail.
// The wrap must land exactly on this period, or the cursor jumps mid-sweep on every wrap.
export const SHIMMER_PERIOD = "thinking".length + SHIMMER_TRAIL;

/** Sweeps a bright highlight across the letters of a status word for the given phase. */
function shimmer(text: string, phase: number): string {
  const chars = [...text];
  const period = chars.length + SHIMMER_TRAIL;
  const head = phase % period;
  return chars
    .map((char, index) => {
      const distance = head - index;
      const colour =
        distance >= 0 && distance < SHIMMER_COLORS.length ? SHIMMER_COLORS[distance] : SHIMMER_BASE;
      return `${colour}${char}\x1b[39m`;
    })
    .join("");
}

/** Renders the PR number as an underlined OSC 8 hyperlink plus its short status. */
function pullRequestCell(ref: PullRequestRef | undefined): string {
  if (ref === undefined) return "";
  const link = `\x1b[4m${hyperlink(`#${ref.number}`, ref.url)}\x1b[24m`;
  const status = pullRequestStatus(ref);
  // A ready PR (Copilot review passed, all threads resolved) stands out in purple.
  return `${link} ${status === "ready" ? purple(status) : status}`;
}

function renderSidebar(state: DashboardState, width: number, height: number): string[] {
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  if (topic === undefined) return fitLines(["DETAIL", "No Topic selected."], width, height);
  const agent = state.mainAgents.find((item) => item.topicId === topic.id);
  const diagnostic =
    topic.setup.reason ??
    agent?.reason ??
    state.diagnostics.find((item) => item.topicId === topic.id)?.message;
  const actions = topicActions(state);
  const setupDetail = state.operations.find((item) => item.topicId === topic.id)?.detail;
  return fitLines(
    [
      state.focus === "detail" ? "> DETAIL" : "  DETAIL",
      `Name: ${topic.name}`,
      `Branch: ${topic.branch}`,
      `Repository: ${topic.repository}`,
      `Base: ${state.baseCheckouts[topic.id] ?? "not observable"}`,
      ...(state.pullRequests[topic.id] === undefined
        ? []
        : [`Pull Request: ${pullRequestCell(state.pullRequests[topic.id])}`]),
      `Worktree: ${topic.worktreePath ?? "not ready"}`,
      `Setup: ${setupDetail ?? topic.setup.state}`,
      `Main Agent: ${agent?.state === "thinking" ? shimmer(agent.state, state.shimmerPhase) : (agent?.state ?? "stopped")}`,
      `Workspace: ${state.workspaces[topic.id] ?? "not observable"}`,
      ...(diagnostic === undefined ? [] : [`Diagnostic: ${diagnostic}`]),
      "",
      state.focus === "actions" ? "> ACTIONS" : "  ACTIONS",
      ...actions.map((action, index) => {
        const pointer = state.focus === "actions" && index === state.focusedAction ? ">" : " ";
        return `${pointer} ${action.label}${action.unavailable ? " · unavailable" : ""}`;
      }),
      "",
      "j/k move · h/l focus · enter invoke · q close details · esc quit",
    ],
    width,
    height,
  );
}

function renderWizard(
  wizard: TopicWizardState,
  width: number,
  height: number,
  knownRepositories: readonly string[],
  inputLine?: string,
): string[] {
  const field = wizard.stage === "review" ? undefined : wizard.stage;
  const title = `ADD TOPIC · ${wizard.stage.toUpperCase()}`;
  const lines = [title, ""];
  if (field !== undefined) {
    const labels = {
      name: "Name",
      branch: "Branch",
      repository: "Repository (owner/repo)",
    } as const;
    lines.push(labels[field], inputLine ?? `> ${wizard[field]}`);
    if (field === "repository") {
      lines.push(...renderRepositoryCompletions(wizard, knownRepositories, width));
    }
  } else {
    lines.push("Review the exact provisioning subject:", "", `Name: ${wizard.name}`);
    lines.push(`Repository: ${wizard.repository}`, `Branch: ${wizard.branch}`);
  }
  if (wizard.error !== undefined) lines.push("", `! ${wizard.error}`);
  lines.push(
    "",
    wizard.stage === "review"
      ? "enter submit · esc cancel"
      : wizard.stage === "repository"
        ? "enter next · ↑/↓ highlight · tab complete · esc cancel"
        : "enter next · esc cancel",
  );
  return fitLines(lines, width, height);
}

// Caps the visible completion window so the wizard footprint stays bounded, and scrolls it
// to keep the highlighted Known repository in view.
function renderRepositoryCompletions(
  wizard: TopicWizardState,
  knownRepositories: readonly string[],
  width: number,
): string[] {
  const matches = filteredRepositories(wizard.repository, knownRepositories);
  if (matches.length === 0) {
    return ["", knownRepositories.length === 0 ? "  (no known repositories)" : "  (no matches)"];
  }
  const highlight = wizard.repositoryHighlight;
  const start =
    highlight === undefined
      ? 0
      : Math.max(
          0,
          Math.min(highlight - REPOSITORY_WINDOW + 1, matches.length - REPOSITORY_WINDOW),
        );
  const window = matches.slice(Math.max(0, start), Math.max(0, start) + REPOSITORY_WINDOW);
  const lines = [""];
  window.forEach((entry, offset) => {
    const index = Math.max(0, start) + offset;
    const marker = index === highlight ? "›" : " ";
    lines.push(truncateToWidth(`${marker} ${entry}`, width));
  });
  if (matches.length > window.length) lines.push(`  … ${matches.length} matches`);
  return lines;
}

const REPOSITORY_WINDOW = 8;

function renderRename(
  rename: TopicRenameState,
  width: number,
  height: number,
  inputLine?: string,
): string[] {
  const lines = ["RENAME TOPIC", "", "New name", inputLine ?? `> ${rename.name}`];
  if (rename.error !== undefined) lines.push("", `! ${rename.error}`);
  lines.push("", "enter rename · esc cancel");
  return fitLines(lines, width, height);
}

function renderConfirmation(
  confirmation: DashboardConfirmation,
  width: number,
  height: number,
): string[] {
  return fitLines(
    [
      `CONFIRM · ${confirmation.action}`,
      "",
      confirmation.text,
      "",
      "This is the exact prepared action from workd.",
      "y/enter approve · n/esc reject",
    ],
    width,
    height,
  );
}

function moveSelection(state: DashboardState, delta: number): DashboardInputResult {
  if (state.topics.length === 0) return { state, exit: false };
  const current = state.topics.findIndex((topic) => topic.id === state.selectedTopicId);
  const index = Math.max(0, Math.min(state.topics.length - 1, (current < 0 ? 0 : current) + delta));
  return {
    state: {
      ...state,
      selectedTopicId: state.topics[index]!.id,
      focusedAction: 0,
    },
    exit: false,
  };
}

function moveActionFocus(state: DashboardState, delta: number): DashboardInputResult {
  const actions = topicActions(state);
  if (actions.length === 0) return { state, exit: false };
  const focusedAction = Math.max(0, Math.min(actions.length - 1, state.focusedAction + delta));
  return { state: { ...state, focusedAction }, exit: false };
}

function policyActionToTopicAction(action: string): TopicActionId[] {
  switch (action) {
    case "terminal.open":
      return ["terminal"];
    case "agent.open":
      return ["agent"];
    case "agent.reset":
      return ["reset-agent"];
    case "topic.delete":
      return ["delete"];
    case "repository.clone":
    case "topic.create-worktree":
      return ["retry"];
    default:
      return [];
  }
}

function topicActions(
  state: DashboardState,
): readonly { id: TopicActionId; label: string; unavailable: boolean }[] {
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  if (topic === undefined) return [];
  const denied = state.unavailableActions[topic.id] ?? [];
  const ready = topic.setup.state === "ready" && topic.worktreePath !== null;
  const actions: Array<{
    id: TopicActionId;
    label: string;
    unavailable: boolean;
  }> = [
    {
      id: "workspace",
      label: "Access Topic Workspace",
      unavailable: denied.includes("workspace"),
    },
    {
      id: "terminal",
      label: "Open Terminal",
      unavailable: !ready || denied.includes("terminal"),
    },
    {
      id: "agent",
      label: "Open Main Agent",
      unavailable: !ready || denied.includes("agent"),
    },
    {
      id: "reset-agent",
      label: "Start New Main Agent",
      unavailable: !ready || denied.includes("reset-agent"),
    },
  ];
  if (state.pullRequests[topic.id] !== undefined) {
    actions.push({
      id: "pull-request",
      label: "Open Pull Request in Browser",
      unavailable: false,
    });
  }
  actions.push({
    id: "rename",
    label: "Rename Topic",
    unavailable: false,
  });
  if (topic.setup.state === "setup-failed" || topic.setup.state === "provisioning") {
    actions.push({
      id: "retry",
      label: "Retry Setup",
      unavailable: denied.includes("retry"),
    });
  }
  actions.push({
    id: "delete",
    label: "Delete Topic",
    unavailable: denied.includes("delete"),
  });
  return actions;
}

function moveFocus(state: DashboardState, delta: number): DashboardInputResult {
  if (!state.sidebarOpen) {
    if (delta > 0 && state.selectedTopicId !== undefined) return openActionRail(state);
    return { state, exit: false };
  }
  const order: readonly DashboardFocus[] = ["list", "detail", "actions"];
  const index = Math.max(0, Math.min(order.length - 1, order.indexOf(state.focus) + delta));
  const focus = order[index]!;
  return {
    state: {
      ...state,
      focus,
      focusedAction: focus === "actions" ? firstAvailableActionIndex(state) : 0,
    },
    exit: false,
  };
}

function openActionRail(state: DashboardState): DashboardInputResult {
  return {
    state: {
      ...state,
      sidebarOpen: true,
      focus: "actions",
      focusedAction: firstAvailableActionIndex(state),
    },
    exit: false,
  };
}

function firstAvailableActionIndex(state: DashboardState): number {
  const index = topicActions(state).findIndex((action) => !action.unavailable);
  return index < 0 ? 0 : index;
}

function invokeTopicAction(
  state: DashboardState,
  action: { id: TopicActionId; label: string },
): DashboardInputResult {
  if (state.selectedTopicId === undefined || action.id === "rename") return { state, exit: false };
  return {
    state: {
      ...state,
      submissionInFlight: action.id,
      message: `${action.label}…`,
    },
    exit: false,
    action: { type: action.id, topicId: state.selectedTopicId },
  };
}

function stabilizeSelection(state: DashboardState, removedIndex = 0): DashboardState {
  if (state.topics.length === 0) {
    const { selectedTopicId: _selected, ...withoutSelection } = state;
    return { ...withoutSelection, sidebarOpen: false, focus: "list" };
  }
  if (
    state.selectedTopicId !== undefined &&
    state.topics.some((topic) => topic.id === state.selectedTopicId)
  ) {
    return state;
  }
  const index = Math.max(0, Math.min(state.topics.length - 1, removedIndex));
  return { ...state, selectedTopicId: state.topics[index]!.id };
}

/** A Topic is active while its Main Agent runs; stopped or failed Agents count as inactive. */
function isMainAgentRunning(state: MainAgentState): boolean {
  return state !== "stopped" && state !== "failed";
}

/** Sorts by name, then bubbles active Topics (running Main Agent) above inactive ones. */
function sortTopics(
  topics: readonly TopicManifest[],
  mainAgents: readonly MainAgentLease[],
): TopicManifest[] {
  const active = new Set(
    mainAgents.filter((agent) => isMainAgentRunning(agent.state)).map((agent) => agent.topicId),
  );
  return [...topics].toSorted((left, right) => {
    const leftActive = active.has(left.id);
    const rightActive = active.has(right.id);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return (
      left.name.localeCompare(right.name) ||
      left.repository.localeCompare(right.repository) ||
      left.id.localeCompare(right.id)
    );
  });
}

function upsert(topics: readonly TopicManifest[], topic: TopicManifest): TopicManifest[] {
  return [...topics.filter((item) => item.id !== topic.id), topic];
}

function upsertDiagnostic(
  diagnostics: readonly TopicDiagnostic[],
  diagnostic: TopicDiagnostic,
): TopicDiagnostic[] {
  return [
    ...diagnostics.filter(
      (item) => item.topicId !== diagnostic.topicId || item.code !== diagnostic.code,
    ),
    diagnostic,
  ];
}

function pad(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function joinColumns(left: string, right: string, leftWidth: number, width: number): string {
  return truncateToWidth(`${pad(left, leftWidth)}│${right}`, width);
}

function fitLines(lines: readonly string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, height).map((line) => truncateToWidth(line, width));
  while (fitted.length < height) fitted.push("");
  return fitted;
}
