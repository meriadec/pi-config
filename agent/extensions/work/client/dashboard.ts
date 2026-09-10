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
  boundMessage,
  isValidBranchName,
  normalizeTopicNote,
  parseRepository,
  pullRequestStatus,
  type MainAgentState,
  type IntegrationTarget,
  type PullRequestRef,
  type TopicManifest,
} from "../shared/domain.ts";
import type { TopicDiagnostic } from "../shared/topic-store.ts";
import { displayChildOrder } from "../shared/integration-chain.ts";
import type { LegacyMigrationFamily, LegacyMigrationPreview } from "../shared/legacy-migration.ts";
import type { IntegrationStatus, IntegrationStatusKind } from "../daemon/integration-status.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";

export { defaultBranchForTopicName } from "../shared/topic-creation.ts";

export type DashboardPhase = "loading" | "connected" | "reconnecting" | "failure";
export type DashboardFocus = "list" | "detail" | "actions";

export type TopicWizardStage = "name" | "startPoint" | "branch" | "repository" | "review";

export interface TopicWizardState {
  stage: TopicWizardStage;
  name: string;
  branch: string;
  repository: string;
  /**
   * Parent Topic of a child-creation wizard. Absent means the add-topic wizard, which
   * asks for a repository instead of a Parent Topic and a Start Point.
   */
  parentTopicId?: string;
  /** Local Git revision of the Parent Topic Branch at which a child Topic starts. */
  startPoint?: string;
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

export interface TopicNoteState {
  topicId: string;
  note: string;
  error?: string;
}

export type TopicActionId =
  | "workspace"
  | "terminal"
  | "agent"
  | "reset-agent"
  | "pull-request"
  | "rename"
  | "note"
  | "add-child"
  | "change-parent"
  | "remove-parent"
  | "move-in-chain"
  | "reset-chain"
  | "migrate-legacy"
  | "retry"
  | "delete";

/**
 * The open, read-only legacy migration preview. It lists every proposed Parent Topic and
 * Integration Target and every skipped Topic, and it writes nothing until it is approved.
 */
export interface MigrationPreviewState {
  preview: LegacyMigrationPreview;
  /** First rendered preview line, so a long preview stays scrollable. */
  offset: number;
}

/**
 * The open chain target chooser of one Topic. It lists only Topics that the daemon can
 * accept, and it never edits Git; Enter submits one durable chain change.
 */
export interface ChainPickerState {
  topicId: string;
  kind: "change-parent" | "move-in-chain";
  index: number;
}

/** One offered chain target. An absent `topicId` names the repository Integration Branch. */
export interface ChainPickerOption {
  label: string;
  topicId?: string;
}

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
  /** Observed Integration Status per Topic id; an absent entry renders as Unknown. */
  integrationStatuses: Readonly<Record<string, IntegrationStatus>>;
  /** Configured Integration Branch per `owner/repo`, absent while none is inferred yet. */
  integrationBranches: Readonly<Record<string, string>>;
  unavailableActions: Readonly<Record<string, readonly TopicActionId[]>>;
  /** Topic ids whose recorded Worktree directory is missing. */
  orphanedTopicIds: readonly string[];
  /** Unresolved legacy name families that the daemon detected without changing them. */
  legacyFamilies: number;
  /** Animation cursor for active-status shimmers. Advanced by a UI timer only. */
  shimmerPhase: number;
  wizard?: TopicWizardState;
  rename?: TopicRenameState;
  note?: TopicNoteState;
  chainPicker?: ChainPickerState;
  /** The open legacy migration preview, which needs explicit approval before any write. */
  migration?: MigrationPreviewState;
  confirmation?: DashboardConfirmation;
  /**
   * In-flight client submissions keyed by submission key: a Topic id for a
   * Topic-scoped action, `"create"` for the add-topic wizard, and
   * `"confirm:<token>"` for a confirmation. Keying the map per Topic lets
   * independent Topics run actions at the same time, so a long provisioning
   * run on one Topic never blocks actions on the others.
   */
  submissions: Readonly<Record<string, SubmissionAction>>;
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
    integrationStatuses: {},
    integrationBranches: {},
    unavailableActions: {},
    orphanedTopicIds: [],
    legacyFamilies: 0,
    shimmerPhase: 0,
    submissions: {},
  };
}

/** True while at least one Main Agent has an animated activity status. */
export function hasShimmeringAgent(state: DashboardState): boolean {
  return state.mainAgents.some(
    (agent) =>
      agent.state === "thinking" || agent.state === "thinking-sub" || agent.state === "tracking-pr",
  );
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
    integrationStatuses: { ...(snapshot.integrationStatuses ?? state.integrationStatuses) },
    integrationBranches: { ...(snapshot.integrationBranches ?? state.integrationBranches) },
    orphanedTopicIds: snapshot.orphanedTopicIds
      ? [...snapshot.orphanedTopicIds]
      : state.orphanedTopicIds,
    legacyFamilies: snapshot.legacyFamilies ?? state.legacyFamilies,
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
      const integrationStatuses = { ...state.integrationStatuses };
      const unavailableActions = { ...state.unavailableActions };
      const orphanedTopicIds = state.orphanedTopicIds.filter((id) => id !== event.topicId);
      delete workspaces[event.topicId];
      delete baseCheckouts[event.topicId];
      delete pullRequests[event.topicId];
      delete integrationStatuses[event.topicId];
      delete unavailableActions[event.topicId];
      return stabilizeSelection(
        {
          ...state,
          topics: state.topics.filter((topic) => topic.id !== event.topicId),
          workspaces,
          baseCheckouts,
          pullRequests,
          integrationStatuses,
          unavailableActions,
          orphanedTopicIds,
        },
        state.topics.findIndex((topic) => topic.id === event.topicId),
      );
    }
    case "diagnostic-added":
      return {
        ...state,
        diagnostics: upsertDiagnostic(state.diagnostics, event.diagnostic),
      };
    case "diagnostic-cleared":
      return {
        ...state,
        diagnostics: state.diagnostics.filter(
          (item) => item.topicId !== event.topicId || item.code !== event.code,
        ),
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
    case "worktree-presence-changed": {
      const orphanedTopicIds = new Set(state.orphanedTopicIds);
      if (event.orphaned) orphanedTopicIds.add(event.topicId);
      else orphanedTopicIds.delete(event.topicId);
      return { ...state, orphanedTopicIds: [...orphanedTopicIds] };
    }
    case "integration-status-changed":
      return {
        ...state,
        integrationStatuses: { ...state.integrationStatuses, [event.topicId]: event.status },
      };
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
        | "delete"
        | "remove-parent"
        | "reset-chain";
      topicId: string;
    }
  | { type: "change-parent"; topicId: string; parentTopicId: string }
  | { type: "migrate-legacy-preview" }
  | { type: "migrate-legacy"; parentTopicIds: readonly string[] }
  | { type: "move-in-chain"; topicId: string; target: IntegrationTarget }
  | {
      type: "create-child";
      input: {
        parentTopicId: string;
        name: string;
        startPoint: string;
        sourceCheckout: string;
        branch?: string;
      };
    }
  | { type: "rename"; topicId: string; name: string }
  | { type: "set-note"; topicId: string; note: string }
  | { type: "set-focus"; topicId: string; focused: boolean }
  | { type: "confirm"; token: string }
  | { type: "reject"; token: string };

export type SubmissionAction = DashboardAction["type"];

/** The submission-map key that a client action occupies while it is in flight. */
export function submissionKey(action: DashboardAction): string {
  switch (action.type) {
    case "create":
    case "create-child":
      return "create";
    case "set-focus":
      // Key by target state so a rapid Unfocus then Focus of one Topic never coalesce.
      return `focus:${action.topicId}:${action.focused}`;
    case "confirm":
    case "reject":
      return `confirm:${action.token}`;
    case "migrate-legacy-preview":
    case "migrate-legacy":
      return "migrate-legacy";
    default:
      return action.topicId;
  }
}

/** True while the selected Topic already has an in-flight submission. */
function isSelectedTopicBusy(state: DashboardState): boolean {
  return (
    state.selectedTopicId !== undefined && state.submissions[state.selectedTopicId] !== undefined
  );
}

export interface DashboardInputResult {
  state: DashboardState;
  exit: boolean;
  action?: DashboardAction;
  refresh?: boolean;
}

export function handleDashboardInput(state: DashboardState, data: string): DashboardInputResult {
  if (state.confirmation !== undefined) return handleConfirmationInput(state, data);
  if (state.rename !== undefined) return handleRenameInput(state, data);
  if (state.note !== undefined) return handleNoteInput(state, data);
  if (state.chainPicker !== undefined) return handleChainPickerInput(state, data);
  if (state.migration !== undefined) return handleMigrationInput(state, data);
  if (state.wizard !== undefined) return handleWizardInput(state, data);
  if ((data === "a" || data === "A") && state.submissions["create"] === undefined) {
    return {
      state: {
        ...state,
        sidebarOpen: false,
        focus: "list",
        wizard: { stage: "name", name: "", branch: "", repository: "", startPoint: "" },
      },
      exit: false,
    };
  }
  if (data === "r") {
    return { state, exit: false, refresh: true };
  }
  if (data === "n" && state.focus === "list" && !isSelectedTopicBusy(state)) {
    return openNotePrompt(state);
  }
  if ((data === "J" || data === "K") && state.focus === "list") {
    return setSelectedTopicFocus(state, data === "K");
  }
  if (data === "m" && state.focus === "list" && !isSelectedTopicBusy(state)) {
    const action = topicActions(state).find((item) => item.id === "agent");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "o" && state.focus === "list" && !isSelectedTopicBusy(state)) {
    const action = topicActions(state).find((item) => item.id === "workspace");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "p" && state.focus === "list" && !isSelectedTopicBusy(state)) {
    const action = topicActions(state).find((item) => item.id === "pull-request");
    if (action !== undefined && !action.unavailable) return invokeTopicAction(state, action);
  }
  if (data === "t" && state.focus === "list" && !isSelectedTopicBusy(state)) {
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
    if (state.focus === "actions" && !isSelectedTopicBusy(state)) {
      const action = topicActions(state)[state.focusedAction];
      if (action === undefined || action.unavailable) return { state, exit: false };
      if (action.id === "rename") return openRenamePrompt(state);
      if (action.id === "note") return openNotePrompt(state);
      if (action.id === "add-child") return openChildWizard(state);
      if (action.id === "change-parent" || action.id === "move-in-chain") {
        return openChainPicker(state, action.id);
      }
      return invokeTopicAction(state, action);
    }
    return openActionRail(state);
  }
  return { state, exit: false };
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
  const child = wizard.parentTopicId !== undefined;
  if (matchesKey(data, Key.escape)) {
    const { wizard: _wizard, ...rest } = state;
    return {
      state: {
        ...rest,
        message: child ? "Child Topic creation cancelled." : "Topic creation cancelled.",
      },
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
            stage: child ? "startPoint" : "repository",
            name,
            branch,
          }),
        },
        exit: false,
      };
    }
    if (wizard.stage === "startPoint") {
      const startPoint = (wizard.startPoint ?? "").trim();
      if (startPoint.length === 0) {
        return wizardError(state, "Start Point must name one commit of the Parent Topic Branch.");
      }
      return {
        state: {
          ...state,
          wizard: clearWizardError({ ...wizard, stage: "branch", startPoint }),
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
      // A child Branch is optional: an empty value leaves the name-to-Branch conversion to workd.
      if (!(child && branch.length === 0) && !isValidBranchName(branch)) {
        return wizardError(state, "Enter a valid non-empty Git branch name.");
      }
      return {
        state: {
          ...state,
          wizard: clearWizardError({ ...wizard, stage: "review", branch }),
        },
        exit: false,
      };
    }
    if (state.submissions["create"] !== undefined) return { state, exit: false };
    return child ? submitChildWizard(state, wizard) : submitTopicWizard(state, wizard);
  }
  if (wizard.stage === "review") return { state, exit: false };
  const field = wizard.stage;
  const current = wizard[field] ?? "";
  let next = current;
  if (matchesKey(data, Key.backspace) || data === "\x7f") next = [...current].slice(0, -1).join("");
  else if (isPrintableInput(data)) next += data;
  else return { state, exit: false };
  return {
    state: updateWizardField(state, next),
    exit: false,
  };
}

function submitTopicWizard(state: DashboardState, wizard: TopicWizardState): DashboardInputResult {
  const { wizard: _wizard, ...rest } = state;
  return {
    state: {
      ...rest,
      submissions: { ...rest.submissions, create: "create" },
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

/**
 * Submits the child wizard against the Parent Topic Worktree, which is the checkout that
 * resolves the Start Point. A Parent Topic without a Worktree keeps the wizard open.
 */
function submitChildWizard(state: DashboardState, wizard: TopicWizardState): DashboardInputResult {
  const parent = state.topics.find((item) => item.id === wizard.parentTopicId);
  const sourceCheckout = parent?.worktreePath ?? undefined;
  if (parent === undefined || sourceCheckout === undefined) {
    return wizardError(state, "The Parent Topic Worktree is not available.");
  }
  const branch = wizard.branch.trim();
  const { wizard: _wizard, ...rest } = state;
  return {
    state: {
      ...rest,
      submissions: { ...rest.submissions, create: "create-child" },
      message: `Creating child Topic ${wizard.name} of ${parent.name}…`,
    },
    exit: false,
    action: {
      type: "create-child",
      input: {
        parentTopicId: parent.id,
        name: wizard.name,
        startPoint: (wizard.startPoint ?? "").trim(),
        sourceCheckout,
        ...(branch.length === 0 ? {} : { branch }),
      },
    },
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

/**
 * Opens the child wizard on the selected Parent Topic. Only a root Topic with a Worktree can
 * offer it, because the Parent Topic Worktree resolves the Start Point.
 */
function openChildWizard(state: DashboardState): DashboardInputResult {
  const parent = state.topics.find((item) => item.id === state.selectedTopicId);
  if (parent === undefined || parent.parentTopicId !== undefined || parent.worktreePath === null) {
    return { state, exit: false };
  }
  return {
    state: {
      ...state,
      sidebarOpen: false,
      focus: "list",
      wizard: {
        stage: "name",
        parentTopicId: parent.id,
        name: "",
        branch: "",
        repository: parent.repository,
        startPoint: "",
      },
    },
    exit: false,
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
    if (state.submissions[rename.topicId] !== undefined) return { state, exit: false };
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
        submissions: { ...rest.submissions, [rename.topicId]: "rename" },
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

function openNotePrompt(state: DashboardState): DashboardInputResult {
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  if (topic === undefined) return { state, exit: false };
  return {
    state: { ...state, note: { topicId: topic.id, note: topic.note ?? "" } },
    exit: false,
  };
}

function handleNoteInput(state: DashboardState, data: string): DashboardInputResult {
  const editor = state.note!;
  if (matchesKey(data, Key.escape)) {
    const { note: _note, ...rest } = state;
    return { state: { ...rest, message: "Topic Note edit cancelled." }, exit: false };
  }
  if (matchesKey(data, Key.enter)) {
    if (state.submissions[editor.topicId] !== undefined) return { state, exit: false };
    let note: string | undefined;
    try {
      note = normalizeTopicNote(editor.note);
    } catch (error) {
      return {
        state: {
          ...state,
          note: {
            ...editor,
            error: error instanceof Error ? error.message : "Topic Note is invalid.",
          },
        },
        exit: false,
      };
    }
    const topic = state.topics.find((item) => item.id === editor.topicId);
    if (topic !== undefined && topic.note === note) {
      const { note: _note, ...rest } = state;
      return { state: { ...rest, message: "Topic Note is unchanged." }, exit: false };
    }
    const { note: _note, ...rest } = state;
    return {
      state: {
        ...rest,
        submissions: { ...rest.submissions, [editor.topicId]: "set-note" },
        message: note === undefined ? "Removing Topic Note…" : "Saving Topic Note…",
      },
      exit: false,
      action: { type: "set-note", topicId: editor.topicId, note: note ?? "" },
    };
  }
  const current = editor.note;
  let next = current;
  if (matchesKey(data, Key.backspace) || data === "\x7f") next = [...current].slice(0, -1).join("");
  else if (isPrintableInput(data)) next += data;
  else return { state, exit: false };
  return { state: updateNoteField(state, next), exit: false };
}

export function updateNoteField(state: DashboardState, value: string): DashboardState {
  const editor = state.note;
  if (editor === undefined) return state;
  const { error: _error, ...withoutError } = editor;
  const note = value.replace(/\r\n?|\n|\u2028|\u2029/g, " ");
  return { ...state, note: { ...withoutError, note } };
}

/**
 * The chain targets that the selected Topic can take. Change Parent lists every root Topic
 * of the same repository that can adopt it; Move in Integration Chain lists the repository
 * Integration Branch and every active sibling, so a target always names one existing edge.
 */
export function chainPickerOptions(
  state: DashboardState,
  picker: ChainPickerState,
): readonly ChainPickerOption[] {
  const topic = state.topics.find((item) => item.id === picker.topicId);
  if (topic === undefined) return [];
  if (picker.kind === "change-parent") {
    return state.topics
      .filter(
        (candidate) =>
          candidate.id !== topic.id &&
          candidate.repository === topic.repository &&
          candidate.parentTopicId === undefined &&
          candidate.id !== topic.parentTopicId &&
          candidate.setup.state === "ready",
      )
      .map((candidate) => ({ label: candidate.name, topicId: candidate.id }));
  }
  const parentTopicId = topic.parentTopicId;
  if (parentTopicId === undefined) return [];
  const branch = state.integrationBranches[topic.repository] ?? "Integration Branch";
  const siblings = state.topics.filter(
    (candidate) =>
      candidate.parentTopicId === parentTopicId &&
      candidate.id !== topic.id &&
      candidate.chainState !== "pending",
  );
  return [
    { label: `${branch} (first in the chain)` },
    ...siblings.map((sibling) => ({
      label: `After ${sibling.name}`,
      topicId: sibling.id,
    })),
  ];
}

/** Opens one chain chooser on the selected Topic, or keeps the state when none is offered. */
function openChainPicker(
  state: DashboardState,
  kind: ChainPickerState["kind"],
): DashboardInputResult {
  const topicId = state.selectedTopicId;
  if (topicId === undefined) return { state, exit: false };
  const picker: ChainPickerState = { topicId, kind, index: 0 };
  if (chainPickerOptions(state, picker).length === 0) return { state, exit: false };
  return {
    state: { ...state, sidebarOpen: false, focus: "list", chainPicker: picker },
    exit: false,
  };
}

function handleChainPickerInput(state: DashboardState, data: string): DashboardInputResult {
  const picker = state.chainPicker!;
  const options = chainPickerOptions(state, picker);
  if (matchesKey(data, Key.escape) || options.length === 0) {
    const { chainPicker: _picker, ...rest } = state;
    return { state: { ...rest, message: "Integration Chain change cancelled." }, exit: false };
  }
  if (matchesKey(data, Key.down) || data === "j") {
    return { state: { ...state, chainPicker: movePicker(picker, options.length, 1) }, exit: false };
  }
  if (matchesKey(data, Key.up) || data === "k") {
    return {
      state: { ...state, chainPicker: movePicker(picker, options.length, -1) },
      exit: false,
    };
  }
  if (!matchesKey(data, Key.enter)) return { state, exit: false };
  if (state.submissions[picker.topicId] !== undefined) return { state, exit: false };
  const option = options[Math.min(picker.index, options.length - 1)]!;
  const { chainPicker: _picker, ...rest } = state;
  if (picker.kind === "change-parent") {
    const parentTopicId = option.topicId!;
    return {
      state: {
        ...rest,
        submissions: { ...rest.submissions, [picker.topicId]: "change-parent" },
        message: `Changing Parent Topic to ${option.label}…`,
      },
      exit: false,
      action: { type: "change-parent", topicId: picker.topicId, parentTopicId },
    };
  }
  const target: IntegrationTarget =
    option.topicId === undefined
      ? { kind: "integration-branch" }
      : { kind: "topic", topicId: option.topicId };
  return {
    state: {
      ...rest,
      submissions: { ...rest.submissions, [picker.topicId]: "move-in-chain" },
      message: `Moving in the Integration Chain: ${option.label}…`,
    },
    exit: false,
    action: { type: "move-in-chain", topicId: picker.topicId, target },
  };
}

function movePicker(picker: ChainPickerState, count: number, delta: number): ChainPickerState {
  return { ...picker, index: Math.max(0, Math.min(count - 1, picker.index + delta)) };
}

function handleConfirmationInput(state: DashboardState, data: string): DashboardInputResult {
  const confirmation = state.confirmation!;
  const key = `confirm:${confirmation.token}`;
  if (state.submissions[key] !== undefined) return { state, exit: false };
  if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
    return {
      state: {
        ...state,
        submissions: { ...state.submissions, [key]: "confirm" },
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
        submissions: { ...state.submissions, [key]: "reject" },
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
    return renderWizard(state, state.wizard, safeWidth, safeHeight, wizardInputLine);
  }
  if (state.rename !== undefined) {
    return renderRename(state.rename, safeWidth, safeHeight, wizardInputLine);
  }
  if (state.note !== undefined) {
    return renderNoteEditor(state.note, safeWidth, safeHeight, wizardInputLine);
  }
  if (state.chainPicker !== undefined) {
    return renderChainPicker(state, state.chainPicker, safeWidth, safeHeight);
  }
  if (state.migration !== undefined) {
    return renderMigrationPreview(state, state.migration, safeWidth, safeHeight);
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
    const columns = wideTopicColumns(state, width);
    if (columns !== undefined) lines.push(renderWideHeader(columns));
    else lines.push(truncateToWidth("  TOPIC · SETUP · MAIN AGENT", width));
    if (view.topics.length === 0) {
      lines.push("", truncateToWidth("No Topics yet.", width));
    } else {
      // Render only the visible window. A large Topic store must not create an unbounded frame.
      // A blank separator splits the Focused part from the Unfocused part; it appears
      // only at the transition inside the window, so one blank line of capacity is reserved
      // when both parts exist.
      const focusedCount = view.topics.filter((topic) => topic.focused).length;
      const bothParts = focusedCount > 0 && focusedCount < view.topics.length;
      const capacity = Math.max(1, height - lines.length - 5 - (bothParts ? 1 : 0));
      const visible = visibleTopics(view.topics, state.selectedTopicId, capacity);
      const displayNames = topicHierarchyNames(view.topics, visible);
      let previousFocused: boolean | undefined;
      for (const topic of visible) {
        if (previousFocused === true && !topic.focused) lines.push("");
        lines.push(
          renderTopicRow(state, topic, displayNames.get(topic.id) ?? topic.name, width, columns),
        );
        previousFocused = topic.focused;
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
      "a Add · j/k or ↑/↓ move · ⇧J/⇧K focus · enter actions · n Note · o workspace · t terminal · m Main Agent · p PR · r refresh · esc quit",
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

const TOPIC_PATH_SEPARATOR = " > ";

/**
 * The rendered family structure of one Topic set. Durable Parent Topic data decides every
 * family it covers; the legacy name-derived hierarchy applies only to Topics that no durable
 * family holds, and it disappears when migration gives every family durable data.
 */
interface TopicHierarchy {
  parentOf: ReadonlyMap<string, TopicManifest>;
  /** Children per Parent Topic id, in Integration Chain order for a durable family. */
  childrenOf: ReadonlyMap<string, readonly TopicManifest[]>;
  /** Parent Topic ids whose children already come from durable chain data. */
  durableParentIds: ReadonlySet<string>;
}

function topicHierarchy(topics: readonly TopicManifest[]): TopicHierarchy {
  const byId = new Map(topics.map((topic) => [topic.id, topic]));
  const parentOf = new Map<string, TopicManifest>();
  const childrenOf = new Map<string, TopicManifest[]>();
  for (const topic of topics) {
    const parent = durableParentTopic(topic, byId);
    if (parent === undefined) continue;
    parentOf.set(topic.id, parent);
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), topic]);
  }
  const durableParentIds = new Set(childrenOf.keys());
  for (const [parentId, children] of childrenOf) {
    childrenOf.set(parentId, displayChildOrder(children));
  }

  // A Topic that durable data does not place keeps the legacy name-derived family.
  const legacy = topics.filter(
    (topic) => topic.parentTopicId === undefined && !durableParentIds.has(topic.id),
  );
  const topicsByName = new Map<string, TopicManifest[]>();
  for (const topic of legacy) {
    const key = hierarchyNameKey(topic.focused, topic.name);
    const matches = topicsByName.get(key) ?? [];
    matches.push(topic);
    topicsByName.set(key, matches);
  }
  for (const topic of legacy) {
    const parent = nearestTopicParent(topic, topicsByName);
    if (parent === undefined || parent.id === topic.id) continue;
    parentOf.set(topic.id, parent);
    childrenOf.set(parent.id, [...(childrenOf.get(parent.id) ?? []), topic]);
  }
  return { parentOf, childrenOf, durableParentIds };
}

/**
 * The Parent Topic that durable data records, or undefined when it cannot render a family:
 * a missing Parent Topic, a second hierarchy level, another repository, or a Focus that
 * differs and would split the family across the Focus separator.
 */
function durableParentTopic(
  topic: TopicManifest,
  byId: ReadonlyMap<string, TopicManifest>,
): TopicManifest | undefined {
  const parentTopicId = topic.parentTopicId;
  if (parentTopicId === undefined || parentTopicId === topic.id) return undefined;
  const parent = byId.get(parentTopicId);
  if (parent === undefined) return undefined;
  if (parent.parentTopicId !== undefined) return undefined;
  if (parent.repository !== topic.repository) return undefined;
  if (parent.focused !== topic.focused) return undefined;
  return parent;
}

/**
 * Shortens a Topic name only when its parent precedes it in this visible group.
 * The durable name stays unchanged.
 */
function topicHierarchyNames(
  allTopics: readonly TopicManifest[],
  visible: readonly TopicManifest[],
): ReadonlyMap<string, string> {
  const allParents = topicHierarchy(allTopics).parentOf;
  const visibleIndex = new Map(visible.map((topic, index) => [topic.id, index]));
  const parents = new Map<string, TopicManifest>();
  visible.forEach((topic, index) => {
    const parent = allParents.get(topic.id);
    const parentIndex = parent === undefined ? undefined : visibleIndex.get(parent.id);
    if (parent !== undefined && parentIndex !== undefined && parentIndex < index) {
      parents.set(topic.id, parent);
    }
  });

  const children = new Map<string, string[]>();
  for (const [childId, parent] of parents) {
    const siblings = children.get(parent.id) ?? [];
    siblings.push(childId);
    children.set(parent.id, siblings);
  }

  const names = new Map<string, string>();
  for (const topic of visible) {
    const parent = parents.get(topic.id);
    if (parent === undefined) {
      names.set(topic.id, topic.name);
      continue;
    }

    const lineage: TopicManifest[] = [];
    let ancestor: TopicManifest | undefined = parent;
    while (ancestor !== undefined) {
      lineage.unshift(ancestor);
      ancestor = parents.get(ancestor.id);
    }
    const continuation = lineage
      .slice(1)
      .map((item) => (isLastHierarchyChild(item.id, parents, children) ? "   " : "│  "))
      .join("");
    const branch = isLastHierarchyChild(topic.id, parents, children) ? "└─ " : "├─ ";
    const remainder = topic.name.startsWith(`${parent.name}${TOPIC_PATH_SEPARATOR}`)
      ? topic.name.slice(parent.name.length + TOPIC_PATH_SEPARATOR.length)
      : topic.name;
    names.set(topic.id, `  ${continuation}${branch}${remainder}`);
  }
  return names;
}

function nearestTopicParent(
  topic: TopicManifest,
  topicsByName: ReadonlyMap<string, readonly TopicManifest[]>,
): TopicManifest | undefined {
  let candidate = topic.name;
  while (candidate.includes(TOPIC_PATH_SEPARATOR)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(TOPIC_PATH_SEPARATOR));
    const matches = topicsByName.get(hierarchyNameKey(topic.focused, candidate));
    if (matches?.length === 1) return matches[0];
  }
  return undefined;
}

function hierarchyNameKey(focused: boolean, name: string): string {
  return `${focused ? "focused" : "unfocused"}\0${name}`;
}

function isLastHierarchyChild(
  topicId: string,
  parents: ReadonlyMap<string, TopicManifest>,
  children: ReadonlyMap<string, readonly string[]>,
): boolean {
  const parent = parents.get(topicId);
  if (parent === undefined) return true;
  return children.get(parent.id)?.at(-1) === topicId;
}

interface TopicColumns {
  name: number;
  integration: number;
  note: number;
  repository: number;
  pullRequest: number;
  setup: number;
  mainAgent: number;
}

const MIN_TOPIC_NAME_WIDTH = 12;
const COLUMN_GAPS_WIDTH = 8; // Selection prefix plus six inter-column spaces.

/** Uses only the space needed by current values, up to stable readability caps. */
function wideTopicColumns(state: DashboardState, width: number): TopicColumns | undefined {
  const note = columnWidth(
    "NOTE",
    state.topics.map((topic) => topic.note ?? ""),
    100,
  );
  const repository = columnWidth(
    "REPOSITORY",
    state.topics.map((topic) => topic.repository),
    32,
  );
  const pullRequest = columnWidth(
    "PR",
    state.topics.map((topic) => pullRequestCell(state.pullRequests[topic.id])),
    18,
  );
  const setup = columnWidth(
    "SETUP",
    state.topics.map((topic) => setupCell(state, topic)),
    14,
  );
  const mainAgent = columnWidth(
    "MAIN AGENT",
    state.topics.map((topic) => {
      const agent = state.mainAgents.find((item) => item.topicId === topic.id)?.state ?? "stopped";
      return mainAgentDisplayLabel(agent);
    }),
    17,
  );
  const integration = visibleWidth(INTEGRATION_HEADER);
  const name =
    width - COLUMN_GAPS_WIDTH - integration - note - repository - pullRequest - setup - mainAgent;
  return name < MIN_TOPIC_NAME_WIDTH
    ? undefined
    : { name, integration, note, repository, pullRequest, setup, mainAgent };
}

function columnWidth(header: string, values: readonly string[], maximum: number): number {
  return Math.min(
    maximum,
    Math.max(visibleWidth(header), ...values.map((value) => visibleWidth(value))),
  );
}

function renderWideHeader(columns: TopicColumns): string {
  return `  ${pad(INTEGRATION_HEADER, columns.integration)} ${pad("TOPIC", columns.name)} ${pad("NOTE", columns.note)} ${pad("REPOSITORY", columns.repository)} ${pad("PR", columns.pullRequest)} ${pad("SETUP", columns.setup)} ${padLeft("MAIN AGENT", columns.mainAgent)}`;
}

function renderTopicRow(
  state: DashboardState,
  topic: TopicManifest,
  displayName: string,
  width: number,
  columns: TopicColumns | undefined,
): string {
  const selected = topic.id === state.selectedTopicId;
  const prefix = selected ? (state.focus === "list" ? "> " : "* ") : "  ";
  const agent = state.mainAgents.find((item) => item.topicId === topic.id)?.state ?? "stopped";
  const agentLabel = mainAgentDisplayLabel(agent);
  const inactive = !isMainAgentRunning(agent);
  // Dim only the status word for an idle Main Agent; the Topic stays active and bubbled up.
  // A Main Agent waiting for a human stands out in yellow.
  const agentCell =
    agent === "idle"
      ? dim(agentLabel)
      : agent === "waiting-for-human"
        ? yellow(agentLabel)
        : renderMainAgentStatus(agent, state.shimmerPhase);
  const pullRequest = state.pullRequests[topic.id];
  const setup = setupCell(state, topic);
  const integration = integrationCell(state, topic);
  if (columns === undefined) {
    const link = pullRequest === undefined ? "" : ` · ${pullRequestCell(pullRequest)}`;
    const setupSegment = setup === "" ? "" : ` · ${setup}`;
    const leading = `${prefix}${integration} ${displayName}`;
    const suffix = `${setupSegment} · ${agentCell}${link}`;
    const note = renderTopicNote(topic.note, width - visibleWidth(`${leading}${suffix}`));
    const row = truncateToWidth(`${leading}${note}${suffix}`, width);
    const styled = inactive ? dim(row) : row;
    return selected ? highlight(styled, width) : styled;
  }
  const noteCell = renderTopicNoteCell(topic.note, columns.note);
  const row = `${prefix}${pad(integration, columns.integration)} ${pad(displayName, columns.name)} ${noteCell} ${pad(topic.repository, columns.repository)} ${pad(pullRequestCell(pullRequest), columns.pullRequest)} ${pad(setup, columns.setup)} ${padLeft(agentCell, columns.mainAgent)}`;
  const styled = inactive ? dim(row) : row;
  return selected ? highlight(styled, width) : styled;
}

// Nerd Font glyphs of the Integration Status column: heading, Current, Behind, Conflict,
// and Unknown. Every glyph measures one cell, so the column never breaks a narrow layout.
const INTEGRATION_HEADER = "\uF47F";
const INTEGRATION_GLYPHS: Readonly<Record<IntegrationStatusKind, string>> = {
  current: "\uF058",
  behind: "\uF063",
  conflict: "\uF071",
  unknown: "\uF059",
};

/** The status glyph of one Topic in its agreed colour; an unobserved Topic is Unknown. */
function integrationCell(state: DashboardState, topic: TopicManifest): string {
  const kind = state.integrationStatuses[topic.id]?.kind ?? "unknown";
  const glyph = INTEGRATION_GLYPHS[kind];
  if (kind === "current") return green(glyph);
  if (kind === "behind") return yellow(glyph);
  if (kind === "conflict") return red(glyph);
  return dim(glyph);
}

function renderTopicNote(note: string | undefined, availableWidth: number): string {
  if (note === undefined || availableWidth <= 1) return "";
  const visible = truncateToWidth(note, availableWidth - 1);
  return visibleWidth(visible) === 0 ? "" : ` ${yellow(visible)}`;
}

function renderTopicNoteCell(note: string | undefined, width: number): string {
  if (note === undefined) return pad("", width);
  return pad(yellow(truncateToWidth(note, width)), width);
}

function setupCell(state: DashboardState, topic: TopicManifest): string {
  // A live Repository Recipe phase replaces the durable setup state. An Orphan Topic
  // replaces a settled ready state with a bright warning.
  const operationDetail = state.operations.find((item) => item.topicId === topic.id)?.detail;
  if (operationDetail !== undefined) return operationDetail;
  if (state.orphanedTopicIds.includes(topic.id)) return brightRed("orphan");
  return topic.setup.state === "ready" ? "" : topic.setup.state;
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

/** Colours text yellow, including an ellipsis inserted by truncation. */
function yellow(text: string): string {
  return `\x1b[33m${reopenAfterReset(text, "\x1b[33m")}\x1b[39m`;
}

/** Colours a settled, current status green. */
function green(text: string): string {
  return `\x1b[32m${reopenAfterReset(text, "\x1b[32m")}\x1b[39m`;
}

/** Colours a blocking status red. */
function red(text: string): string {
  return `\x1b[31m${reopenAfterReset(text, "\x1b[31m")}\x1b[39m`;
}

/** Colours an urgent status word bright red. */
function brightRed(text: string): string {
  return `\x1b[91m${text}\x1b[39m`;
}

/** Colours a status word a light violet. */
function purple(text: string): string {
  return `\x1b[38;5;183m${text}\x1b[39m`;
}

interface ShimmerPalette {
  readonly base: string;
  readonly sweep: readonly string[];
}

// Thinking uses violet; Tracking PR uses blue. Both keep the same bright sweep animation.
const THINKING_SHIMMER: ShimmerPalette = {
  base: "\x1b[38;5;146m",
  sweep: ["\x1b[38;5;231m", "\x1b[38;5;189m", "\x1b[38;5;183m"],
};
const TRACKING_PR_SHIMMER: ShimmerPalette = {
  base: "\x1b[38;5;109m",
  sweep: ["\x1b[38;5;195m", "\x1b[38;5;159m", "\x1b[38;5;117m"],
};
// A trailing gap after each word makes each sweep restart after a clear pause.
const SHIMMER_TRAIL = 4;

// 180 is the least common multiple of the animation lengths: thinking (12),
// thinking (sub) (18), and tracking-pr (15). Wrapping lets all animations restart
// without a visible jump.
export const SHIMMER_PERIOD = 180;

/** Maps control-plane state to the exact user-visible Main Agent label. */
export function mainAgentDisplayLabel(state: MainAgentState): string {
  return state === "thinking-sub" ? "thinking (sub)" : state;
}

/** Renders one Main Agent status with its shared label, palette, and animation rule. */
function renderMainAgentStatus(state: MainAgentState, shimmerPhase: number): string {
  const label = mainAgentDisplayLabel(state);
  if (state === "thinking" || state === "thinking-sub") {
    return shimmer(label, shimmerPhase, THINKING_SHIMMER);
  }
  if (state === "tracking-pr") {
    return shimmer(label, shimmerPhase, TRACKING_PR_SHIMMER);
  }
  return label;
}

/** Sweeps a bright highlight across the letters of a status word for the given phase. */
function shimmer(text: string, phase: number, palette: ShimmerPalette): string {
  const chars = [...text];
  const period = chars.length + SHIMMER_TRAIL;
  const head = phase % period;
  return chars
    .map((char, index) => {
      const distance = head - index;
      const colour =
        distance >= 0 && distance < palette.sweep.length ? palette.sweep[distance] : palette.base;
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
      `Worktree: ${topic.worktreePath ?? "not ready"}${state.orphanedTopicIds.includes(topic.id) ? ` · ${brightRed("orphan")}` : ""}`,
      `Setup: ${setupDetail ?? topic.setup.state}`,
      ...integrationDetailLines(state, topic),
      `Main Agent: ${renderMainAgentStatus(agent?.state ?? "stopped", state.shimmerPhase)}`,
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

const INTEGRATION_LABELS: Readonly<Record<IntegrationStatusKind, string>> = {
  current: "Current",
  behind: "Behind",
  conflict: "Conflict",
  unknown: "Unknown",
};

/**
 * Textual Integration Status of one Topic for the detail view: status word, Integration
 * Target, Integration Branch, ahead and behind counts, pending chain state, and one bounded
 * diagnostic. An unobserved Topic reads as Unknown instead of disappearing.
 */
function integrationDetailLines(state: DashboardState, topic: TopicManifest): string[] {
  const status = state.integrationStatuses[topic.id];
  const kind = status?.kind ?? "unknown";
  const parts = [INTEGRATION_LABELS[kind]];
  if (status?.target !== undefined) parts.push(`target ${status.target}`);
  if (status?.ahead !== undefined) parts.push(`ahead ${status.ahead}`);
  if (status?.behind !== undefined) parts.push(`behind ${status.behind}`);
  if (topic.chainState === "pending") parts.push("pending insertion");
  const parent = state.topics.find((item) => item.id === topic.parentTopicId);
  const integrationBranch = state.integrationBranches[topic.repository];
  const detail = status?.detail;
  return [
    `Integration: ${parts.join(" · ")}`,
    ...(integrationBranch === undefined ? [] : [`Integration Branch: ${integrationBranch}`]),
    ...(parent === undefined ? [] : [`Parent Topic: ${parent.name}`]),
    ...(detail === undefined ? [] : [`Integration detail: ${boundMessage(detail)}`]),
  ];
}

function renderWizard(
  state: DashboardState,
  wizard: TopicWizardState,
  width: number,
  height: number,
  inputLine?: string,
): string[] {
  const parent = state.topics.find((item) => item.id === wizard.parentTopicId);
  const field = wizard.stage === "review" ? undefined : wizard.stage;
  const subject = parent === undefined ? "ADD TOPIC" : "ADD CHILD TOPIC";
  const lines = [`${subject} · ${WIZARD_STAGE_TITLES[wizard.stage]}`, ""];
  if (parent !== undefined) lines.push(`Parent Topic: ${parent.name}`, "");
  if (field !== undefined) {
    lines.push(WIZARD_FIELD_LABELS[field], inputLine ?? `> ${wizard[field] ?? ""}`);
    if (field === "repository") {
      lines.push(...renderRepositoryCompletions(wizard, state.knownRepositories, width));
    }
  } else {
    lines.push("Review the exact provisioning subject:", "", `Name: ${wizard.name}`);
    if (parent === undefined) lines.push(`Repository: ${wizard.repository}`);
    else lines.push(`Start Point: ${wizard.startPoint ?? ""}`);
    lines.push(
      `Branch: ${wizard.branch.trim().length === 0 ? "derived from the Topic name" : wizard.branch}`,
    );
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

const WIZARD_STAGE_TITLES: Readonly<Record<TopicWizardStage, string>> = {
  name: "NAME",
  startPoint: "START POINT",
  branch: "BRANCH",
  repository: "REPOSITORY",
  review: "REVIEW",
};

const WIZARD_FIELD_LABELS: Readonly<Record<Exclude<TopicWizardStage, "review">, string>> = {
  name: "Name",
  startPoint: "Start Point (commit of the Parent Topic Branch)",
  branch: "Branch",
  repository: "Repository (owner/repo)",
};

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

function renderNoteEditor(
  editor: TopicNoteState,
  width: number,
  height: number,
  inputLine?: string,
): string[] {
  const lines = ["EDIT TOPIC NOTE", "", "Note", inputLine ?? `> ${editor.note}`];
  if (editor.error !== undefined) lines.push("", `! ${editor.error}`);
  lines.push("", "enter save · empty removes · esc cancel");
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

function renderChainPicker(
  state: DashboardState,
  picker: ChainPickerState,
  width: number,
  height: number,
): string[] {
  const topic = state.topics.find((item) => item.id === picker.topicId);
  const options = chainPickerOptions(state, picker);
  const title =
    picker.kind === "change-parent" ? "CHANGE PARENT TOPIC" : "MOVE IN INTEGRATION CHAIN";
  return fitLines(
    [
      `${title} · ${topic?.name ?? picker.topicId}`,
      "",
      ...options.map((option, index) => `${index === picker.index ? ">" : " "} ${option.label}`),
      "",
      "No Branch moves and no Git history changes.",
      "j/k or \u2191/\u2193 move \u00b7 enter apply \u00b7 esc cancel",
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

/**
 * Sets the Focus of the selected Topic's complete family with one keypress. Idempotent: a
 * no-op when the family already has that Focus. It updates optimistically and re-sorts so the
 * family visibly crosses the separator; the daemon `topic-changed` events later reconcile.
 * Selection stays on the same Topic.
 */
function setSelectedTopicFocus(state: DashboardState, focused: boolean): DashboardInputResult {
  const topic = state.topics.find((item) => item.id === state.selectedTopicId);
  if (topic === undefined) return { state, exit: false };
  const family = topicFamilyIds(state.topics, topic);
  if (state.topics.every((item) => !family.has(item.id) || item.focused === focused)) {
    return { state, exit: false };
  }
  const topics = sortTopics(
    state.topics.map((item) => (family.has(item.id) ? { ...item, focused } : item)),
    state.mainAgents,
  );
  return {
    state: { ...state, topics },
    exit: false,
    action: { type: "set-focus", topicId: topic.id, focused },
  };
}

/**
 * The Topic ids of one complete family: the Parent Topic and every child that durable data
 * or the legacy name hierarchy places under it. A Topic without a family is its own family.
 */
function topicFamilyIds(
  topics: readonly TopicManifest[],
  topic: TopicManifest,
): ReadonlySet<string> {
  const hierarchy = topicHierarchy(topics);
  const root = hierarchy.parentOf.get(topic.id) ?? topic;
  const ids = new Set<string>([root.id]);
  const collect = (parent: TopicManifest): void => {
    for (const child of hierarchy.childrenOf.get(parent.id) ?? []) {
      if (ids.has(child.id)) continue;
      ids.add(child.id);
      collect(child);
    }
  };
  collect(root);
  return ids;
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

/**
 * The safe chain repairs that the selected Topic can offer. Every entry only rewires
 * durable links; none of them moves a Branch or changes Git history. An entry appears only
 * when the daemon can already accept it, so the side view never offers an empty chooser.
 */
function chainMaintenanceActions(
  state: DashboardState,
  topic: TopicManifest,
  ready: boolean,
): { id: TopicActionId; label: string; unavailable: boolean }[] {
  const pending = topic.chainState === "pending";
  const children = state.topics.filter((item) => item.parentTopicId === topic.id);
  const actions: { id: TopicActionId; label: string; unavailable: boolean }[] = [];
  // Only a Topic without children can join another family, because families stay one level deep.
  if (children.length === 0) {
    const candidates = chainPickerOptions(state, {
      topicId: topic.id,
      kind: "change-parent",
      index: 0,
    });
    if (candidates.length > 0) {
      actions.push({
        id: "change-parent",
        label: "Change Parent Topic",
        unavailable: !ready || pending,
      });
    }
  }
  if (topic.parentTopicId !== undefined) {
    actions.push({
      id: "remove-parent",
      label: "Remove Parent Topic",
      unavailable: !ready || pending,
    });
    const targets = chainPickerOptions(state, {
      topicId: topic.id,
      kind: "move-in-chain",
      index: 0,
    });
    if (targets.length > 1) {
      actions.push({
        id: "move-in-chain",
        label: "Move in Integration Chain",
        unavailable: !ready || pending,
      });
    }
  }
  if (topic.parentTopicId === undefined && children.length > 0) {
    actions.push({
      id: "reset-chain",
      label: "Reset Integration Target",
      unavailable: !ready,
    });
  }
  // Legacy migration is a metadata-only action of the whole control plane, offered while an
  // unresolved ` > ` name family still exists.
  if (state.legacyFamilies > 0) {
    actions.push({
      id: "migrate-legacy",
      label: "Migrate Legacy Name Hierarchies",
      unavailable: state.submissions["migrate-legacy"] !== undefined,
    });
  }
  return actions;
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
  actions.push({
    id: "note",
    label: topic.note === undefined ? "Add Note" : "Edit Note",
    unavailable: false,
  });
  if (topic.setup.state === "setup-failed" || topic.setup.state === "provisioning") {
    actions.push({
      id: "retry",
      label: "Retry Setup",
      unavailable: denied.includes("retry"),
    });
  }
  // Only a root Topic can offer a child, because a family stays one level deep.
  if (topic.parentTopicId === undefined) {
    actions.push({
      id: "add-child",
      label: "Add Child Topic",
      unavailable: !ready || state.submissions["create"] !== undefined,
    });
  }
  for (const maintenance of chainMaintenanceActions(state, topic, ready)) {
    actions.push(maintenance);
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
  if (action.id === "migrate-legacy") return requestMigrationPreview(state);
  // Rename, Note, Add Child Topic, and the chain choosers open a view instead of one
  // daemon submission.
  if (
    state.selectedTopicId === undefined ||
    action.id === "rename" ||
    action.id === "note" ||
    action.id === "add-child" ||
    action.id === "change-parent" ||
    action.id === "move-in-chain"
  ) {
    return { state, exit: false };
  }
  return {
    state: {
      ...state,
      submissions: { ...state.submissions, [state.selectedTopicId]: action.id },
      message: `${action.label}…`,
    },
    exit: false,
    action: { type: action.id, topicId: state.selectedTopicId },
  };
}

/** Asks workd for the read-only migration preview. The request changes nothing on disk. */
function requestMigrationPreview(state: DashboardState): DashboardInputResult {
  if (state.submissions["migrate-legacy"] !== undefined) return { state, exit: false };
  return {
    state: {
      ...state,
      sidebarOpen: false,
      focus: "list",
      submissions: { ...state.submissions, "migrate-legacy": "migrate-legacy-preview" },
      message: "Building the legacy migration preview…",
    },
    exit: false,
    action: { type: "migrate-legacy-preview" },
  };
}

/** Opens the preview that workd returned. Opening it still writes nothing. */
export function openMigrationPreview(
  state: DashboardState,
  preview: LegacyMigrationPreview,
): DashboardState {
  if (preview.families.length === 0 && preview.skipped.length === 0) {
    return { ...state, message: "No legacy name family can migrate." };
  }
  return { ...state, migration: { preview, offset: 0 }, message: "Legacy migration preview." };
}

function handleMigrationInput(state: DashboardState, data: string): DashboardInputResult {
  const migration = state.migration!;
  if (matchesKey(data, Key.escape)) {
    const { migration: _migration, ...rest } = state;
    return { state: { ...rest, message: "Legacy migration cancelled." }, exit: false };
  }
  if (matchesKey(data, Key.down) || data === "j") {
    return {
      state: { ...state, migration: { ...migration, offset: migration.offset + 1 } },
      exit: false,
    };
  }
  if (matchesKey(data, Key.up) || data === "k") {
    return {
      state: {
        ...state,
        migration: { ...migration, offset: Math.max(0, migration.offset - 1) },
      },
      exit: false,
    };
  }
  if (!matchesKey(data, Key.enter)) return { state, exit: false };
  const parentTopicIds = migration.preview.families.map((family) => family.parentTopicId);
  if (parentTopicIds.length === 0) {
    const { migration: _migration, ...rest } = state;
    return { state: { ...rest, message: "No legacy family can migrate." }, exit: false };
  }
  if (state.submissions["migrate-legacy"] !== undefined) return { state, exit: false };
  const { migration: _migration, ...rest } = state;
  return {
    state: {
      ...rest,
      submissions: { ...rest.submissions, "migrate-legacy": "migrate-legacy" },
      message: `Migrating ${parentTopicIds.length} legacy famil${parentTopicIds.length === 1 ? "y" : "ies"}…`,
    },
    exit: false,
    action: { type: "migrate-legacy", parentTopicIds },
  };
}

/** The preview lines of one family: its Parent Topic and every proposed Integration Target. */
function migrationFamilyLines(state: DashboardState, family: LegacyMigrationFamily): string[] {
  const name = (topicId: string): string =>
    state.topics.find((topic) => topic.id === topicId)?.name ?? topicId.slice(0, 8);
  const target = (value: LegacyMigrationFamily["parentIntegrationTarget"]): string =>
    value.kind === "integration-branch" ? "Integration Branch" : name(value.topicId);
  return [
    `Parent Topic ${name(family.parentTopicId)} → ${target(family.parentIntegrationTarget)}`,
    ...family.children.map(
      (child) => `  child ${name(child.topicId)} → ${target(child.integrationTarget)}`,
    ),
  ];
}

function renderMigrationPreview(
  state: DashboardState,
  migration: MigrationPreviewState,
  width: number,
  height: number,
): string[] {
  const preview = migration.preview;
  const body = [
    ...preview.families.flatMap((family) => migrationFamilyLines(state, family)),
    ...(preview.skipped.length === 0 ? [] : ["", "Unchanged:"]),
    ...preview.skipped.map((skip) => {
      const topic = state.topics.find((item) => item.id === skip.topicId);
      return `  ${topic?.name ?? skip.topicId.slice(0, 8)} · ${skip.code} · ${skip.message}`;
    }),
  ];
  const visible = body.slice(Math.min(migration.offset, Math.max(0, body.length - 1)));
  return fitLines(
    [
      `MIGRATE LEGACY NAME HIERARCHIES · ${preview.families.length} famil${preview.families.length === 1 ? "y" : "ies"}`,
      "",
      ...visible,
      "",
      "This preview changed nothing. Approving writes Topic metadata only.",
      "j/k or \u2191/\u2193 scroll \u00b7 enter approve \u00b7 esc cancel",
    ],
    width,
    height,
  );
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

/**
 * Keeps Topic families together while active families and subtrees bubble above inactive
 * peers. A durable family keeps its Integration Chain order, so a child never moves
 * alphabetically or bubbles away from the chain position that its Integration Target records.
 */
function sortTopics(
  topics: readonly TopicManifest[],
  mainAgents: readonly MainAgentLease[],
): TopicManifest[] {
  const active = new Set(
    mainAgents.filter((agent) => isMainAgentRunning(agent.state)).map((agent) => agent.topicId),
  );
  const hierarchy = topicHierarchy(topics);
  const parents = hierarchy.parentOf;
  const children = hierarchy.childrenOf;

  const activeFamilies = new Map<string, boolean>();
  const familyIsActive = (topic: TopicManifest): boolean => {
    const cached = activeFamilies.get(topic.id);
    if (cached !== undefined) return cached;
    const result =
      active.has(topic.id) || (children.get(topic.id) ?? []).some((child) => familyIsActive(child));
    activeFamilies.set(topic.id, result);
    return result;
  };
  const comparePeers = (left: TopicManifest, right: TopicManifest): number => {
    const leftActive = familyIsActive(left);
    const rightActive = familyIsActive(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return compareTopicNames(left, right);
  };

  const roots = topics.filter((topic) => !parents.has(topic.id));
  roots.sort((left, right) => {
    if (left.focused !== right.focused) return left.focused ? -1 : 1;
    return comparePeers(left, right);
  });
  const sorted: TopicManifest[] = [];
  const appendFamily = (topic: TopicManifest): void => {
    sorted.push(topic);
    for (const child of orderedChildren(topic, hierarchy, comparePeers)) appendFamily(child);
  };
  for (const root of roots) appendFamily(root);
  return sorted;
}

/** Chain order inside a durable family; the legacy peer order everywhere else. */
function orderedChildren(
  parent: TopicManifest,
  hierarchy: TopicHierarchy,
  comparePeers: (left: TopicManifest, right: TopicManifest) => number,
): readonly TopicManifest[] {
  const children = hierarchy.childrenOf.get(parent.id) ?? [];
  return hierarchy.durableParentIds.has(parent.id) ? children : children.toSorted(comparePeers);
}

function compareTopicNames(left: TopicManifest, right: TopicManifest): number {
  return (
    left.name.localeCompare(right.name) ||
    left.repository.localeCompare(right.repository) ||
    left.id.localeCompare(right.id)
  );
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

function padLeft(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

function joinColumns(left: string, right: string, leftWidth: number, width: number): string {
  return truncateToWidth(`${pad(left, leftWidth)}│${right}`, width);
}

function fitLines(lines: readonly string[], width: number, height: number): string[] {
  const fitted = lines.slice(0, height).map((line) => truncateToWidth(line, width));
  while (fitted.length < height) fitted.push("");
  return fitted;
}
