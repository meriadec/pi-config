import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { decodeBranch, type OperationId, type TopicId } from "../domain/index.ts";
import { defaultBranchForTopicName } from "../shared/topic-creation.ts";

export type ChildTopicWizardStage =
  | "name"
  | "startPoint"
  | "branch"
  | "review"
  | "submitting"
  | "confirmation";

export interface ChildTopicWizardState {
  readonly stage: ChildTopicWizardStage;
  readonly parentTopicId: TopicId;
  readonly parentName: string;
  readonly parentBranch: string;
  readonly sourceCheckout: string;
  readonly name: string;
  readonly startPoint: string;
  readonly branch: string;
  readonly error?: string;
  readonly progress?: string;
  readonly createdTopicId?: TopicId;
  readonly operationId?: OperationId;
  readonly confirmation?: string;
}

export interface ChildTopicWizardSubmit {
  readonly name: string;
  readonly parentTopicId: string;
  readonly startPoint: string;
  readonly branch?: string;
  readonly sourceCheckout: string;
}

export interface ChildTopicWizardResult {
  readonly state?: ChildTopicWizardState;
  readonly submit?: ChildTopicWizardSubmit;
  readonly confirm?: boolean;
  readonly reject?: boolean;
  readonly cancelWait?: boolean;
}

export function initialChildTopicWizardState(parent: {
  readonly id: TopicId;
  readonly name: string;
  readonly branch: string;
  readonly worktreePath: string;
}): ChildTopicWizardState {
  return {
    stage: "name",
    parentTopicId: parent.id,
    parentName: parent.name,
    parentBranch: parent.branch,
    sourceCheckout: parent.worktreePath,
    name: "",
    startPoint: "",
    branch: "",
  };
}

export function updateChildTopicWizardField(
  state: ChildTopicWizardState,
  value: string,
): ChildTopicWizardState {
  if (state.stage !== "name" && state.stage !== "startPoint" && state.stage !== "branch") {
    return state;
  }
  const { error: _error, progress: _progress, ...rest } = state;
  return { ...rest, [state.stage]: value };
}

/** Reduces semantic wizard keys. StandardTextEntry owns text and cursor editing. */
export function handleChildTopicWizardInput(
  state: ChildTopicWizardState,
  data: string,
): ChildTopicWizardResult {
  if (state.stage === "submitting") {
    return matchesKey(data, Key.escape) ? { cancelWait: true } : { state };
  }
  if (state.stage === "confirmation") {
    if (matchesKey(data, Key.escape) || data === "n" || data === "N") {
      return {
        state: { ...state, stage: "submitting", progress: "Rejecting child Topic creation…" },
        reject: true,
      };
    }
    if (matchesKey(data, Key.enter) || data === "y" || data === "Y") {
      return {
        state: { ...state, stage: "submitting", progress: "Provisioning child Topic…" },
        confirm: true,
      };
    }
    return { state };
  }
  if (matchesKey(data, Key.escape)) return {};
  if (!matchesKey(data, Key.enter)) return { state };

  if (state.stage === "name") {
    const name = state.name.trim();
    if (name.length === 0) return wizardError(state, "Child Topic name must not be empty.");
    if (name.length > 200)
      return wizardError(state, "Child Topic name must not exceed 200 characters.");
    if (defaultBranchForTopicName(name).length === 0)
      return wizardError(state, "Child Topic name cannot make a safe Branch.");
    return { state: { ...state, stage: "startPoint", name } };
  }
  if (state.stage === "startPoint") {
    const startPoint = state.startPoint.trim();
    if (startPoint.length === 0) return wizardError(state, "Start Point must not be empty.");
    return { state: { ...state, stage: "branch", startPoint } };
  }
  if (state.stage === "branch") {
    if (state.branch.trim().length > 0) {
      try {
        decodeBranch(state.branch);
      } catch {
        return wizardError(state, "Enter an empty Branch or a valid safe Git Branch name.");
      }
    }
    return {
      state: {
        ...state,
        stage: "review",
        branch: state.branch.trim().length === 0 ? "" : state.branch,
      },
    };
  }

  return {
    state: { ...state, stage: "submitting", progress: "Resolving the Start Point…" },
    submit: {
      name: state.name,
      parentTopicId: state.parentTopicId,
      startPoint: state.startPoint,
      ...(state.branch.length === 0 ? {} : { branch: state.branch }),
      sourceCheckout: state.sourceCheckout,
    },
  };
}

export function renderChildTopicWizard(
  state: ChildTopicWizardState,
  width: number,
  height: number,
  inputLine?: string,
): string[] {
  const lines = [
    `\x1b[1mADD CHILD TOPIC · ${state.stage.toUpperCase()}\x1b[22m`,
    "",
    `Parent Topic: ${state.parentName}`,
    `Parent Branch: ${state.parentBranch}`,
    "",
  ];
  if (state.stage === "name" || state.stage === "startPoint" || state.stage === "branch") {
    lines.push(
      state.stage === "name"
        ? "Name"
        : state.stage === "startPoint"
          ? "Start Point on the Parent Branch"
          : "Branch (optional)",
      inputLine ?? `> ${state[state.stage]}`,
    );
    if (state.stage === "branch" && state.branch.length === 0) {
      lines.push(`Empty uses: ${defaultBranchForTopicName(state.name)}`);
    }
  } else {
    lines.push(
      `Name: ${state.name}`,
      `Start Point: ${state.startPoint}`,
      `Branch: ${state.branch || `${defaultBranchForTopicName(state.name)} (from name)`}`,
    );
    if (state.stage !== "review") {
      lines.push(
        "",
        state.progress ??
          (state.stage === "confirmation"
            ? "Child Topic creation needs confirmation."
            : "Provisioning child Topic…"),
      );
    }
  }
  if (state.error !== undefined) lines.push("", `\x1b[31m${state.error}\x1b[39m`);
  lines.push(
    "",
    state.stage === "review"
      ? "Enter submit · Escape cancel"
      : state.stage === "confirmation"
        ? "y/Enter confirm · n/Escape reject"
        : state.stage === "submitting"
          ? "Escape stop waiting"
          : "Enter next · Escape cancel",
  );
  const result = lines
    .slice(0, Math.max(1, height))
    .map((line) => truncateToWidth(line, Math.max(1, width)));
  while (result.length < Math.max(1, height)) result.push("");
  return result;
}

function wizardError(state: ChildTopicWizardState, error: string): ChildTopicWizardResult {
  return { state: { ...state, error } };
}
