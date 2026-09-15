import { fuzzyFilter, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { decodeBranch, decodeRepository, type TopicId } from "../domain/index.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";

export type RootTopicWizardStage =
  | "name"
  | "repository"
  | "branch"
  | "review"
  | "submitting"
  | "confirmation";

export interface RootTopicWizardState {
  readonly stage: RootTopicWizardStage;
  readonly name: string;
  readonly repository: string;
  readonly branch: string;
  readonly repositoryHighlight?: number;
  readonly error?: string;
  readonly progress?: string;
  readonly createdTopicId?: TopicId;
}

export interface RootTopicWizardResult {
  readonly state?: RootTopicWizardState;
  readonly submit?: { readonly name: string; readonly repository: string; readonly branch: string };
  readonly confirm?: boolean;
  readonly reject?: boolean;
}

export function initialRootTopicWizardState(): RootTopicWizardState {
  return { stage: "name", name: "", repository: "", branch: "" };
}

/** Known repositories that fuzzy-match the typed text. Empty text shows all known values. */
export function filteredKnownRepositories(
  repository: string,
  knownRepositories: readonly string[],
): readonly string[] {
  const query = repository.trim();
  return query.length === 0
    ? [...knownRepositories]
    : fuzzyFilter([...knownRepositories], query, (value) => value);
}

/** Replaces the active field after standard text editing and resets completion selection. */
export function updateRootTopicWizardField(
  state: RootTopicWizardState,
  value: string,
  knownRepositories: readonly string[],
): RootTopicWizardState {
  if (state.stage !== "name" && state.stage !== "repository" && state.stage !== "branch") {
    return state;
  }
  const { error: _error, progress: _progress, repositoryHighlight: _highlight, ...rest } = state;
  if (state.stage !== "repository") return { ...rest, [state.stage]: value };
  const matches = filteredKnownRepositories(value, knownRepositories);
  return {
    ...rest,
    repository: value,
    ...(value.trim().length > 0 && matches.length > 0 ? { repositoryHighlight: 0 } : {}),
  };
}

export function moveRootRepositoryHighlight(
  state: RootTopicWizardState,
  knownRepositories: readonly string[],
  delta: number,
): RootTopicWizardState {
  if (state.stage !== "repository") return state;
  const matches = filteredKnownRepositories(state.repository, knownRepositories);
  if (matches.length === 0) return state;
  const next = Math.max(0, Math.min(matches.length - 1, (state.repositoryHighlight ?? -1) + delta));
  return { ...state, repositoryHighlight: next };
}

export function completeRootRepository(
  state: RootTopicWizardState,
  knownRepositories: readonly string[],
): { readonly state: RootTopicWizardState; readonly value?: string } {
  if (state.stage !== "repository" || state.repositoryHighlight === undefined) return { state };
  const value = filteredKnownRepositories(state.repository, knownRepositories)[
    state.repositoryHighlight
  ];
  if (value === undefined) return { state };
  return { state: { ...state, repository: value, repositoryHighlight: 0 }, value };
}

/** Reduces semantic wizard keys. Text insertion and cursor editing stay in StandardTextEntry. */
export function handleRootTopicWizardInput(
  state: RootTopicWizardState,
  data: string,
): RootTopicWizardResult {
  if (state.stage === "submitting") return { state };
  if (state.stage === "confirmation") {
    if (matchesKey(data, Key.escape)) {
      return {
        state: { ...state, stage: "submitting", progress: "Rejecting Topic creation…" },
        reject: true,
      };
    }
    if (data === "y" || data === "Y" || matchesKey(data, Key.enter)) {
      return {
        state: { ...state, stage: "submitting", progress: "Provisioning Topic…" },
        confirm: true,
      };
    }
    if (data === "n" || data === "N") {
      return {
        state: { ...state, stage: "submitting", progress: "Rejecting Topic creation…" },
        reject: true,
      };
    }
    return { state };
  }
  if (matchesKey(data, Key.escape)) return {};
  if (!matchesKey(data, Key.enter)) return { state };
  if (state.stage === "name") {
    const name = state.name.trim();
    if (name.length === 0) return wizardError(state, "Topic name must not be empty.");
    if (name.length > 200) return wizardError(state, "Topic name must not exceed 200 characters.");
    const branch = defaultBranchForTopicName(name);
    if (branch.length === 0) return wizardError(state, "Topic name cannot make a safe Branch.");
    return { state: { ...state, stage: "repository", name, branch } };
  }
  if (state.stage === "repository") {
    const repository = state.repository.trim();
    try {
      decodeRepository(repository);
    } catch {
      return wizardError(state, "Repository must have the exact owner/repo form.");
    }
    return { state: { ...state, stage: "branch", repository } };
  }
  if (state.stage === "branch") {
    const branch = state.branch.trim();
    try {
      decodeBranch(branch);
    } catch {
      return wizardError(state, "Enter a valid non-empty safe Git Branch name.");
    }
    return { state: { ...state, stage: "review", branch } };
  }
  return {
    state: { ...state, stage: "submitting", progress: "Starting Topic creation…" },
    submit: { name: state.name, repository: state.repository, branch: state.branch },
  };
}

export function renderRootTopicWizard(
  state: RootTopicWizardState,
  knownRepositories: readonly string[],
  width: number,
  height: number,
  inputLine?: string,
): string[] {
  const title = state.stage.toUpperCase();
  const lines = [`\x1b[1mADD TOPIC · ${title}\x1b[22m`, ""];
  if (state.stage === "name" || state.stage === "repository" || state.stage === "branch") {
    lines.push(
      state.stage === "name"
        ? "Name"
        : state.stage === "repository"
          ? "Repository (owner/repo)"
          : "Branch",
      inputLine ?? `> ${state[state.stage]}`,
    );
    if (state.stage === "repository") {
      const matches = filteredKnownRepositories(state.repository, knownRepositories);
      lines.push("", "Known repositories");
      if (matches.length === 0)
        lines.push(knownRepositories.length === 0 ? "  (none)" : "  (no matches)");
      else {
        const highlight = state.repositoryHighlight;
        for (const [index, repository] of matches.slice(0, 8).entries()) {
          lines.push(`${index === highlight ? ">" : " "} ${repository}`);
        }
      }
    }
  } else if (state.stage === "review") {
    lines.push(
      "Review the exact Topic identity:",
      "",
      `Name: ${state.name}`,
      `Repository: ${state.repository}`,
      `Branch: ${state.branch}`,
    );
  } else {
    lines.push(
      `Name: ${state.name}`,
      `Repository: ${state.repository}`,
      `Branch: ${state.branch}`,
      "",
      state.progress ??
        (state.stage === "confirmation"
          ? "Topic creation needs confirmation."
          : "Provisioning Topic…"),
    );
  }
  if (state.error !== undefined) lines.push("", `\x1b[31m${state.error}\x1b[39m`);
  lines.push(
    "",
    state.stage === "review"
      ? "Enter submit · Escape cancel"
      : state.stage === "repository"
        ? "Enter next · ↑/↓ highlight · Tab complete · Escape cancel"
        : state.stage === "confirmation"
          ? "y/Enter confirm · n/Escape cancel"
          : state.stage === "submitting"
            ? "Please wait"
            : "Enter next · Escape cancel",
  );
  const result = lines
    .slice(0, Math.max(1, height))
    .map((line) => truncateToWidth(line, Math.max(1, width)));
  while (result.length < Math.max(1, height)) result.push("");
  return result;
}

function wizardError(state: RootTopicWizardState, error: string): RootTopicWizardResult {
  return { state: { ...state, error } };
}
