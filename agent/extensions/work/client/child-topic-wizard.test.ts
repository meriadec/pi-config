import { describe, expect, test } from "bun:test";
import { TopicId } from "../domain/index.ts";
import {
  handleChildTopicWizardInput,
  initialChildTopicWizardState,
  updateChildTopicWizardField,
} from "./child-topic-wizard.ts";

const parent = {
  id: TopicId.make("10000000-0000-4000-8000-000000000001"),
  name: "Parent Topic",
  branch: "parent-topic",
  worktreePath: "/work/parent-topic",
};

describe("child Topic creation wizard", () => {
  test("collects name, Start Point, and an optional exact Branch", () => {
    let state = updateChildTopicWizardField(initialChildTopicWizardState(parent), "Child Work");
    state = handleChildTopicWizardInput(state, "\r").state!;
    expect(state.stage).toBe("startPoint");
    state = updateChildTopicWizardField(state, "HEAD~2");
    state = handleChildTopicWizardInput(state, "\r").state!;
    state = updateChildTopicWizardField(state, "Feature/Exact-Case");
    state = handleChildTopicWizardInput(state, "\r").state!;
    expect(state).toMatchObject({ stage: "review", parentName: "Parent Topic" });
    expect(handleChildTopicWizardInput(state, "\r").submit).toEqual({
      name: "Child Work",
      parentTopicId: parent.id,
      startPoint: "HEAD~2",
      branch: "Feature/Exact-Case",
      sourceCheckout: "/work/parent-topic",
    });
  });

  test("leaves an empty Branch for deterministic conversion", () => {
    let state = updateChildTopicWizardField(initialChildTopicWizardState(parent), "Child Work");
    state = handleChildTopicWizardInput(state, "\r").state!;
    state = updateChildTopicWizardField(state, "HEAD");
    state = handleChildTopicWizardInput(state, "\r").state!;
    state = handleChildTopicWizardInput(state, "\r").state!;
    expect(handleChildTopicWizardInput(state, "\r").submit).toEqual({
      name: "Child Work",
      parentTopicId: parent.id,
      startPoint: "HEAD",
      sourceCheckout: "/work/parent-topic",
    });
  });

  test("validates fields and Escape cancels all pre-request stages", () => {
    let state = initialChildTopicWizardState(parent);
    expect(handleChildTopicWizardInput(state, "\r").state?.error).toBe(
      "Child Topic name must not be empty.",
    );
    state = updateChildTopicWizardField(state, "Child");
    state = handleChildTopicWizardInput(state, "\r").state!;
    expect(handleChildTopicWizardInput(state, "\r").state?.error).toBe(
      "Start Point must not be empty.",
    );
    state = updateChildTopicWizardField(state, "HEAD");
    state = handleChildTopicWizardInput(state, "\r").state!;
    state = updateChildTopicWizardField(state, "bad branch");
    expect(handleChildTopicWizardInput(state, "\r").state?.error).toBe(
      "Enter an empty Branch or a valid safe Git Branch name.",
    );
    expect(handleChildTopicWizardInput(state, "\x1b").state).toBeUndefined();
    expect(
      handleChildTopicWizardInput({ ...state, stage: "review" }, "\x1b").state,
    ).toBeUndefined();
  });

  test("Escape during progress stops only the local wait", () => {
    const state = { ...initialChildTopicWizardState(parent), stage: "submitting" as const };
    expect(handleChildTopicWizardInput(state, "\x1b")).toEqual({ cancelWait: true });
    expect(handleChildTopicWizardInput(state, "\r")).toEqual({ state });
  });
});
