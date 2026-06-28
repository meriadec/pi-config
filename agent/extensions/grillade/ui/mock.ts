import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { askGrilladeQuestionInUi } from "./question.ts";
import { getGrilladeMockCase, GRILLADE_MOCK_CASES, type GrilladeMockCase } from "./mockCases.ts";

export function registerGrilladeMockCommand(pi: ExtensionAPI): void {
  pi.registerCommand("grillade-mock", {
    description: "Open Grillade UI mock fixtures without calling the model",
    handler: async (args, ctx) => {
      await handleGrilladeMockCommand(args, ctx);
    },
  });
}

async function handleGrilladeMockCommand(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    ctx.ui.notify("/grillade-mock requires interactive Pi TUI mode.", "warning");
    return;
  }

  const requested = args.trim();
  if (!requested || requested === "--list" || requested === "list") {
    const selected = await selectMockCase(ctx);
    if (!selected) return;
    await runMockCase(ctx, selected);
    return;
  }

  if (requested === "all") {
    for (const mockCase of GRILLADE_MOCK_CASES) {
      const shouldContinue = await runMockCase(ctx, mockCase);
      if (!shouldContinue) break;
    }
    return;
  }

  const mockCase = getGrilladeMockCase(requested);
  if (!mockCase) {
    ctx.ui.notify(
      `Unknown Grillade mock '${requested}'. Run /grillade-mock --list to choose a fixture.`,
      "warning",
    );
    return;
  }

  await runMockCase(ctx, mockCase);
}

async function selectMockCase(ctx: ExtensionCommandContext): Promise<GrilladeMockCase | undefined> {
  const options = [
    ...GRILLADE_MOCK_CASES.map(
      (mockCase) => `${mockCase.id} — ${mockCase.label}: ${mockCase.description}`,
    ),
    "all — Run every mock fixture in sequence",
  ];
  const selected = await ctx.ui.select("Open Grillade mock fixture", options);
  if (!selected) return undefined;
  if (selected.startsWith("all —")) return { ...GRILLADE_MOCK_CASES[0]!, id: "__all__" };
  const id = selected.split(" — ", 1)[0] ?? "";
  return getGrilladeMockCase(id);
}

async function runMockCase(
  ctx: ExtensionCommandContext,
  mockCase: GrilladeMockCase,
): Promise<boolean> {
  if (mockCase.id === "__all__") {
    for (const nestedCase of GRILLADE_MOCK_CASES) {
      const shouldContinue = await runMockCase(ctx, nestedCase);
      if (!shouldContinue) return false;
    }
    return true;
  }

  ctx.ui.setTitle(`Grillade mock: ${mockCase.id}`);
  ctx.ui.setStatus("grillade-mock", `Grillade mock ${mockCase.id}`);
  const result = await askGrilladeQuestionInUi(ctx, mockCase.question, undefined, {
    ...(mockCase.docsMode !== undefined ? { docsMode: mockCase.docsMode } : {}),
    ...(mockCase.mode !== undefined ? { mode: mockCase.mode } : {}),
  });
  ctx.ui.setStatus("grillade-mock", undefined);

  if (result.status === "answered") {
    const answer = result.selectedOptionId
      ? `selected ${result.selectedOptionId}`
      : "submitted custom answer";
    ctx.ui.notify(`Mock ${mockCase.id}: ${answer}.`, "info");
    return true;
  }

  ctx.ui.notify(`Mock ${mockCase.id}: ${result.status}.`, "info");
  return false;
}
