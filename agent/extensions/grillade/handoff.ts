import type { GrilladeFinalActionId, GrilladeFinishInput } from "./protocol.ts";

export type GrilladeHandoffOptions = {
  originalPrompt: string;
  docsMode: boolean;
  selectedAt: string;
  steering?: string;
};

export function isNormalPiHandoffAction(
  actionId: GrilladeFinalActionId,
): actionId is "implement_now" | "create_epic_issues" | "create_update_docs" {
  return (
    actionId === "implement_now" ||
    actionId === "create_epic_issues" ||
    actionId === "create_update_docs"
  );
}

export function buildNormalPiHandoffPrompt(
  actionId: "implement_now" | "create_epic_issues" | "create_update_docs",
  finish: GrilladeFinishInput,
  options: GrilladeHandoffOptions,
): string {
  const lines = [
    "You are now back in normal Pi, outside the Grillade UI. Act on this completed Grillade handoff using normal repository workflows.",
    "",
    "Do not use Grillade tools or reopen the Grillade UI unless the user explicitly asks to continue grilling.",
    "Keep repository mutations visible in the normal Pi flow, inspect the repo before editing, and run the appropriate validation harness for the work you perform.",
    "",
    ...formatHandoffContext(actionId, finish, options),
    "",
    ...formatActionInstructions(actionId),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatHandoffContext(
  actionId: GrilladeFinalActionId,
  finish: GrilladeFinishInput,
  options: GrilladeHandoffOptions,
): string[] {
  const lines = [
    "## Grillade handoff context",
    "",
    `- Selected action: ${formatActionLabel(actionId)}`,
    `- Selected at: ${options.selectedAt}`,
    `- Docs mode during interview: ${options.docsMode ? "enabled" : "disabled"}`,
    "",
    "### Original prompt",
    options.originalPrompt,
    "",
    "### Summary",
    finish.summary,
    "",
    "### Decisions",
    ...formatList(finish.decisions),
    "",
    "### Open questions / risks",
    ...formatList(finish.openQuestions ?? [], "None captured."),
  ];

  if (finish.docsProposalSummaries?.length) {
    lines.push(
      "",
      "### Docs opportunities captured during Grillade",
      ...formatList(finish.docsProposalSummaries),
    );
  }
  if (options.steering) {
    lines.push("", "### User note for this handoff", options.steering);
  }

  return lines;
}

function formatActionInstructions(
  actionId: "implement_now" | "create_epic_issues" | "create_update_docs",
): string[] {
  switch (actionId) {
    case "implement_now":
      return [
        "## Normal Pi task: implement now",
        "",
        "Implement the decided plan from the Grillade context above.",
        "",
        "Requirements:",
        "- First inspect relevant repository guidance and available skills before changing code (for example AGENTS.md, README/docs, and task-specific skill instructions when applicable).",
        "- Follow the repository's module, testing, and workflow conventions; do not bypass normal repo review of file mutations.",
        "- Use the Grillade decisions as the plan, but stop and ask for clarification if an open question materially blocks a safe implementation choice.",
        "- Run the appropriate targeted tests/checks and the repo harness recommended by the repo guidance for the files you change.",
      ];
    case "create_epic_issues":
      return [
        "## Normal Pi task: create epic/issues",
        "",
        "Create epic/issue artifacts from the Grillade plan.",
        "",
        "Requirements:",
        "- First inspect current repository guidance and available skills before creating files.",
        "- Follow the repository's issue/epic convention exactly; do not invent a convention.",
        "- If no clear convention exists, ask for clarification before creating files.",
        "- For this repo, the expected convention is local Markdown under `.scratch/<feature-slug>/`, specifically `.scratch/<feature-slug>/PRD.md` and `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, as described by `docs/agents/issue-tracker.md`; verify that guidance before writing.",
        "- Turn the summary, decisions, open questions, and risks into actionable, numbered issues with clear status/front matter according to the discovered convention.",
      ];
    case "create_update_docs":
      return [
        "## Normal Pi task: create/update docs in Pi",
        "",
        "Update project documentation using the Grillade decisions and docs opportunities above.",
        "",
        "Requirements:",
        "- First inspect current repository guidance, available skills, domain-modeling rules, and docs conventions before writing (for this repo, start with `docs/agents/domain.md`, `CONTEXT.md`, and relevant ADR/docs files when present).",
        "- Use domain-modeling discipline: preserve established vocabulary, name new concepts deliberately, and surface ADR conflicts instead of silently overriding them.",
        "- Follow the repository's documentation convention; do not invent a location or format.",
        "- If the convention or context is unclear, ask for clarification before creating or updating documentation files.",
        "- Run the appropriate checks for any files you change.",
      ];
  }
}

function formatList(items: readonly string[], emptyText = "None captured."): string[] {
  if (items.length === 0) return [emptyText];
  return items.map((item) => `- ${item}`);
}

function formatActionLabel(actionId: GrilladeFinalActionId): string {
  switch (actionId) {
    case "implement_now":
      return "Implement now";
    case "create_epic_issues":
      return "Create epic/issues";
    case "create_update_docs":
      return "Create/update docs in Pi";
    case "continue_grilling":
      return "Continue grilling / add details";
    case "export_summary":
      return "Export summary";
    case "close":
      return "Close";
  }
}
