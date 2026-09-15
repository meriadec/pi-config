import { describe, expect, test } from "bun:test";
import {
  completeRootRepository,
  filteredKnownRepositories,
  handleRootTopicWizardInput,
  initialRootTopicWizardState,
  moveRootRepositoryHighlight,
  updateRootTopicWizardField,
} from "./root-topic-wizard.ts";

describe("root Topic creation wizard", () => {
  const known = ["LedgerHQ/app-bitcoin", "LedgerHQ/ledger-live", "owner/repo"];

  test("collects the exact identity in name, repository, Branch, and review order", () => {
    let state = updateRootTopicWizardField(
      initialRootTopicWizardState(),
      "VG-123 Fix Login",
      known,
    );
    state = handleRootTopicWizardInput(state, "\r").state!;
    expect(state).toMatchObject({ stage: "repository", branch: "VG-123-fix-login" });
    state = updateRootTopicWizardField(state, "owner/repo", known);
    state = handleRootTopicWizardInput(state, "\r").state!;
    expect(state.stage).toBe("branch");
    state = updateRootTopicWizardField(state, "VG-123-fix-login-edited", known);
    state = handleRootTopicWizardInput(state, "\r").state!;
    expect(state).toMatchObject({
      stage: "review",
      name: "VG-123 Fix Login",
      repository: "owner/repo",
      branch: "VG-123-fix-login-edited",
    });
    expect(handleRootTopicWizardInput(state, "\r").submit).toEqual({
      name: "VG-123 Fix Login",
      repository: "owner/repo",
      branch: "VG-123-fix-login-edited",
    });
  });

  test("validates each field precisely and Escape cancels each editable stage", () => {
    let state = initialRootTopicWizardState();
    expect(handleRootTopicWizardInput(state, "\r").state?.error).toBe(
      "Topic name must not be empty.",
    );
    state = updateRootTopicWizardField(state, "***", known);
    expect(handleRootTopicWizardInput(state, "\r").state?.error).toBe(
      "Topic name cannot make a safe Branch.",
    );
    state = updateRootTopicWizardField(state, "Alpha", known);
    state = handleRootTopicWizardInput(state, "\r").state!;
    state = updateRootTopicWizardField(state, "https://github.com/owner/repo", known);
    expect(handleRootTopicWizardInput(state, "\r").state?.error).toBe(
      "Repository must have the exact owner/repo form.",
    );
    state = updateRootTopicWizardField(state, "owner/repo", known);
    state = handleRootTopicWizardInput(state, "\r").state!;
    state = updateRootTopicWizardField(state, "unsafe branch", known);
    expect(handleRootTopicWizardInput(state, "\r").state?.error).toBe(
      "Enter a valid non-empty safe Git Branch name.",
    );
    expect(handleRootTopicWizardInput(state, "\x1b").state).toBeUndefined();
  });

  test("fuzzy filters, moves the highlight, and completes only with Tab", () => {
    let state = handleRootTopicWizardInput(
      updateRootTopicWizardField(initialRootTopicWizardState(), "Alpha", known),
      "\r",
    ).state!;
    state = updateRootTopicWizardField(state, "ledger", known);
    expect(filteredKnownRepositories(state.repository, known)).toHaveLength(2);
    expect(state.repositoryHighlight).toBe(0);
    state = moveRootRepositoryHighlight(state, known, 1);
    expect(state.repositoryHighlight).toBe(1);
    const completed = completeRootRepository(state, known);
    expect(completed.value).toBe("LedgerHQ/ledger-live");
    const typed = updateRootTopicWizardField(state, "owner/repo", known);
    expect(handleRootTopicWizardInput(typed, "\r").state).toMatchObject({
      stage: "branch",
      repository: "owner/repo",
    });
  });
});
