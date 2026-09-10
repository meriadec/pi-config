import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WORK_PROTOCOL_VERSION, type DaemonSnapshot, type WorkEvent } from "../daemon/protocol.ts";
import type {
  LegacyMigrationApplyResult,
  LegacyMigrationPreviewResult,
  TopicMutationResult,
  WorkActionResult,
} from "../daemon/topic-service.ts";
import type { LegacyMigrationPreview } from "../shared/legacy-migration.ts";
import type { IntegrationStatus } from "../daemon/integration-status.ts";
import type { MainAgentActionResult, WorkspaceActionResult } from "../daemon/desktop.ts";
import type { IntegrationTarget, NewTopic, TopicManifest } from "../shared/domain.ts";
import { createConfigStore, createWorkPaths } from "../shared/index.ts";
import { WorkDashboardComponent, type DashboardClient } from "./dashboard-component.ts";
import type { ResolvedChildTopicCreationInput } from "./topic-creation.ts";
import {
  dashboardViewModel,
  handleDashboardInput,
  hydrateDashboard,
  openMigrationPreview,
  initialDashboardState,
  advanceShimmer,
  hasShimmeringAgent,
  mainAgentDisplayLabel,
  SHIMMER_PERIOD,
  reduceDashboardEvent,
  renderDashboard,
  defaultBranchForTopicName,
  isValidRepositoryInput,
  filteredRepositories,
  updateWizardField,
  moveRepositoryHighlight,
  applyRepositoryCompletion,
} from "./dashboard.ts";
import type { DashboardState } from "./dashboard.ts";
import { completeWorkBaseSetup, defaultWorkConfig, validateWorkBase } from "./setup.ts";

const roots: string[] = [];
const ID_A = "123e4567-e89b-42d3-a456-426614174000";
const ID_B = "123e4567-e89b-42d3-a456-426614174001";
const ID_C = "123e4567-e89b-42d3-a456-426614174002";
const ID_D = "123e4567-e89b-42d3-a456-426614174003";
const ID_E = "123e4567-e89b-42d3-a456-426614174004";

function stripSgr(text: string): string {
  let visible = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\x1b" && text[index + 1] === "[") {
      while (index < text.length && text[index] !== "m") index += 1;
    } else {
      visible += text[index];
    }
  }
  return visible;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "work-dashboard-test-"));
  roots.push(root);
  return root;
}

function topic(
  id: string,
  name: string,
  setup: TopicManifest["setup"]["state"] = "ready",
  focused = true,
  note?: string,
) {
  return {
    version: 1,
    id,
    name,
    ...(note === undefined ? {} : { note }),
    branch: `feat-${name}`,
    repository: `owner/${name.toLowerCase()}`,
    setup: {
      state: setup,
      repositoryAvailable: setup === "ready",
      worktreeCreated: setup === "ready",
      setupCommandsRun: setup === "ready",
      ...(setup === "setup-failed" ? { reason: "wt failed" } : {}),
    },
    worktreePath: setup === "ready" ? `/work/${name}` : null,
    focused,
    mainAgent: { sessionId: id, sessionFile: null },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } satisfies TopicManifest;
}

// Nerd Font glyphs of the Integration Status column.
const INTEGRATION_HEADER = "\uF47F";
const CURRENT_GLYPH = "\uF058";
const CONFLICT_GLYPH = "\uF071";
const UNKNOWN_GLYPH = "\uF059";

/** One Topic with durable chain data: Parent Topic, Integration Target, and chain state. */
function familyTopic(
  id: string,
  name: string,
  chain: {
    parentTopicId?: string;
    integrationTarget?: TopicManifest["integrationTarget"];
    chainState?: TopicManifest["chainState"];
    setup?: TopicManifest["setup"]["state"];
  },
): TopicManifest {
  return {
    ...topic(id, name, chain.setup ?? "ready"),
    repository: "owner/family",
    ...(chain.parentTopicId === undefined ? {} : { parentTopicId: chain.parentTopicId }),
    ...(chain.integrationTarget === undefined
      ? {}
      : { integrationTarget: chain.integrationTarget }),
    ...(chain.chainState === undefined ? {} : { chainState: chain.chainState }),
  };
}

function snapshot(
  topics: readonly TopicManifest[] = [],
  knownRepositories: readonly string[] = [],
  integrationStatuses: Readonly<Record<string, IntegrationStatus>> = {},
): DaemonSnapshot {
  return {
    integrationStatuses,
    revision: 0,
    topics,
    diagnostics: [],
    operations: [],
    knownRepositories,
    mainAgents: topics.map((item) => ({
      topicId: item.id,
      sessionId: item.id,
      state: "stopped",
      connected: false,
    })),
    baseCheckouts: Object.fromEntries(
      topics.map((item) => [item.id, `/base/${item.repository.split("/")[1]}`]),
    ),
    daemon: {
      protocolVersion: WORK_PROTOCOL_VERSION,
      pid: 10,
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("WORK_BASE setup", () => {
  test("expands, validates, and saves a writable absolute directory", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const workBase = join(home, "ledger");
    const runtime = join(root, "runtime");
    await Promise.all([mkdir(workBase, { recursive: true }), mkdir(runtime, { recursive: true })]);
    const paths = createWorkPaths({ home, runtime });
    const store = createConfigStore(paths);
    const answers = ["relative", "~/ledger"];
    const errors: string[] = [];

    const configured = await completeWorkBaseSetup(
      store,
      {
        input: async () => answers.shift(),
        notify: (message) => errors.push(message),
      },
      { home },
    );

    expect(errors).toEqual(["WORK_BASE must be an absolute directory path."]);
    expect(configured?.workBase).toBe(workBase);
    expect((await store.load())?.workBase).toBe(workBase);
    expect((await stat(paths.config)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({ workBase });
  });

  test("rejects missing, non-directory, and non-writable paths", async () => {
    expect(
      await validateWorkBase("/missing", {
        fileSystem: {
          stat: async () => {
            throw new Error("missing");
          },
          access,
        },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must exist and be writable." });
    expect(
      await validateWorkBase("/file", {
        fileSystem: { stat: async () => ({ isDirectory: () => false }), access },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must be a directory." });
    expect(
      await validateWorkBase("/locked", {
        fileSystem: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => {
            throw new Error("locked");
          },
        },
      }),
    ).toEqual({ ok: false, message: "WORK_BASE must exist and be writable." });
  });

  test("cancels without creating partial configuration", async () => {
    const root = await temporaryRoot();
    const paths = createWorkPaths({ home: join(root, "home"), runtime: join(root, "runtime") });
    const result = await completeWorkBaseSetup(createConfigStore(paths), {
      input: async () => undefined,
      notify: () => undefined,
    });
    expect(result).toBeUndefined();
    expect(await Bun.file(paths.config).exists()).toBeFalse();
  });

  test("keeps existing policy configuration when workBase is added", async () => {
    const root = await temporaryRoot();
    const home = join(root, "home");
    const base = join(root, "base");
    const paths = createWorkPaths({ home, runtime: join(root, "runtime") });
    await mkdir(base, { recursive: true });
    const store = createConfigStore(paths);
    const config = defaultWorkConfig(base);
    delete config.workBase;
    config.policies.defaults["terminal.open"] = "deny";
    await store.save(config);
    await completeWorkBaseSetup(store, {
      input: async () => base,
      notify: () => undefined,
    });
    expect((await store.load())?.policies.defaults["terminal.open"]).toBe("deny");
  });
});

describe("Topic creation wizard", () => {
  test("makes deterministic safe branch defaults", () => {
    expect(defaultBranchForTopicName("VG-123 Fix Login")).toBe("VG-123-fix-login");
    expect(defaultBranchForTopicName("Write a useful release note")).toBe(
      "write-a-useful-release-note",
    );
    expect(defaultBranchForTopicName("  Spaces & punctuation!!!  ")).toBe("spaces-punctuation");
    expect(defaultBranchForTopicName("Été déjà vu")).toBe("ete-deja-vu");
    expect(defaultBranchForTopicName(" : / .. ")).toBe("");
    expect(defaultBranchForTopicName("   ")).toBe("");
  });

  test("asks for the repository before the generated Branch", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "VG-123 Fix Login").state;
    state = handleDashboardInput(state, "\r").state;

    expect(state.wizard).toMatchObject({
      stage: "repository",
      branch: "VG-123-fix-login",
    });
  });

  test("accepts bracketed paste through the wizard text input", async () => {
    const component = dashboardComponent(new FakeDashboardClient());
    await Bun.sleep(0);
    component.handleInput("a");
    component.handleInput("\x1b[200~VG-31025 Tokenization\x1b[201~");
    component.handleInput("\r");

    expect(component.snapshotState().wizard).toMatchObject({
      stage: "repository",
      name: "VG-31025 Tokenization",
    });
    component.dispose();
  });

  test("supports cursor editing in wizard fields", async () => {
    const component = dashboardComponent(new FakeDashboardClient());
    await Bun.sleep(0);
    component.handleInput("a");
    component.handleInput("Cursor test");
    component.handleInput("\r");
    component.handleInput("owner/reo");
    component.handleInput("\x1b[D");
    component.handleInput("p");
    component.handleInput("\r");

    expect(component.snapshotState().wizard).toMatchObject({
      stage: "branch",
      repository: "owner/repo",
    });
    component.dispose();
  });

  test("keeps the generated branch editable and validates repository references", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "VG-123 Fix Login").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({ stage: "repository", branch: "VG-123-fix-login" });
    state = handleDashboardInput(state, "LedgerHQ/revault").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("branch");
    state = handleDashboardInput(state, "\x7f").state;
    state = handleDashboardInput(state, "-api").state;
    expect(state.wizard?.branch).toBe("VG-123-fix-logi-api");
    expect(isValidRepositoryInput("LedgerHQ/revault")).toBeTrue();
    expect(isValidRepositoryInput("https://github.com/LedgerHQ/revault")).toBeFalse();
    expect(isValidRepositoryInput("owner/")).toBeFalse();
  });

  test("does not advance with empty or unsafe fields", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({ stage: "name", error: "Topic name must not be empty." });
    state = handleDashboardInput(state, "***").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard).toMatchObject({
      stage: "name",
      error: "Topic name cannot make a safe branch.",
    });
  });

  test("cancels without submission from every wizard stage", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "Alpha").state;
    state = handleDashboardInput(state, "\r").state;
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("repository");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "owner/repo").state;
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("branch");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
    state = handleDashboardInput(state, "\r").state;
    expect(state.wizard?.stage).toBe("review");
    expect(handleDashboardInput(state, "\x1b").state.wizard).toBeUndefined();
  });

  test("shows and submits the exact reviewed repository and branch", () => {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    for (const input of ["Alpha", "\r", "owner/repo", "\r", "-edited", "\r"]) {
      state = handleDashboardInput(state, input).state;
    }
    const lines = renderDashboard(state, 80, 16).join("\n");
    expect(lines).toContain("Repository: owner/repo");
    expect(lines).toContain("Branch: alpha-edited");
    const result = handleDashboardInput(state, "\r");
    expect(result.action).toEqual({
      type: "create",
      input: { name: "Alpha", branch: "alpha-edited", repository: "owner/repo" },
    });
  });
});

describe("Known repository completion", () => {
  const known = ["LedgerHQ/app-bitcoin", "LedgerHQ/ledger-live", "owner/repo"] as const;

  function repositoryStage(input = ""): DashboardState {
    let state = handleDashboardInput(initialDashboardState(), "a").state;
    state = handleDashboardInput(state, "Alpha").state;
    state = handleDashboardInput(state, "\r").state;
    state = { ...state, knownRepositories: [...known] };
    return input.length === 0 ? state : updateWizardField(state, input);
  }

  test("lists every known repository with no highlight for empty input", () => {
    const state = repositoryStage();
    expect(filteredRepositories("", known)).toEqual([...known]);
    expect(state.wizard?.repositoryHighlight).toBeUndefined();
    const lines = renderDashboard(state, 80, 24).join("\n");
    expect(lines).toContain("LedgerHQ/ledger-live");
    expect(lines).toContain("tab complete");
  });

  test("highlights the best match on typing and resets to the top on further edits", () => {
    let state = repositoryStage("ledger");
    expect(state.wizard?.repositoryHighlight).toBe(0);
    state = moveRepositoryHighlight(state, 1);
    expect(state.wizard?.repositoryHighlight).toBe(1);
    // A further keystroke resets the highlight back to the best match.
    state = updateWizardField(state, "ledger-l");
    expect(state.wizard?.repositoryHighlight).toBe(0);
  });

  test("clears the highlight when the input matches nothing", () => {
    const state = repositoryStage("zzz-nomatch");
    expect(filteredRepositories("zzz-nomatch", known)).toEqual([]);
    expect(state.wizard?.repositoryHighlight).toBeUndefined();
  });

  test("down-arrow from no highlight lands on the first row", () => {
    let state = repositoryStage();
    state = moveRepositoryHighlight(state, 1);
    expect(state.wizard?.repositoryHighlight).toBe(0);
    state = moveRepositoryHighlight(state, -1);
    expect(state.wizard?.repositoryHighlight).toBe(0);
  });

  test("tab writes the highlighted repository and stays on the stage", () => {
    const state = repositoryStage("ledger");
    const completed = applyRepositoryCompletion(state);
    expect(completed.value).toBe("LedgerHQ/app-bitcoin");
    expect(completed.state.wizard).toMatchObject({
      stage: "repository",
      repository: "LedgerHQ/app-bitcoin",
    });
  });

  test("tab is a no-op while nothing is highlighted", () => {
    const state = repositoryStage();
    const completed = applyRepositoryCompletion(state);
    expect(completed.value).toBeUndefined();
    expect(completed.state).toBe(state);
  });

  test("enter submits the typed text, never the highlight", () => {
    const state = repositoryStage("owner/repo");
    expect(state.wizard?.repositoryHighlight).toBe(0);
    const advanced = handleDashboardInput(state, "\r").state;
    expect(advanced.wizard).toMatchObject({ stage: "branch", repository: "owner/repo" });
  });

  test("completes through the component with down-arrow then tab, then submits", async () => {
    const client = new FakeDashboardClient([]);
    client.knownRepositories = [...known];
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("a");
    component.handleInput("Alpha");
    component.handleInput("\r");
    component.handleInput("ledger");
    // Best match is highlighted on typing; down-arrow moves to the next row, tab adopts it.
    component.handleInput("\x1b[B");
    component.handleInput("\t");
    expect(component.snapshotState().wizard).toMatchObject({
      stage: "repository",
      repository: "LedgerHQ/ledger-live",
    });
    component.handleInput("\r");
    expect(component.snapshotState().wizard?.stage).toBe("branch");
    component.dispose();
  });
});

describe("dashboard state and navigation", () => {
  test("builds loading, empty, connected, reconnecting, failure, and diagnostic views", () => {
    const loading = initialDashboardState();
    expect(dashboardViewModel(loading).kind).toBe("loading");
    const empty = hydrateDashboard(loading, snapshot());
    expect(dashboardViewModel(empty).kind).toBe("empty");
    const connected = hydrateDashboard(empty, {
      ...snapshot([topic(ID_A, "Alpha")]),
      diagnostics: [{ topicId: "broken", code: "invalid-data", message: "Corrupt Topic." }],
    });
    expect(dashboardViewModel(connected)).toMatchObject({
      kind: "connected",
      diagnostics: [{ message: "Corrupt Topic." }],
    });
    expect(
      dashboardViewModel(reduceDashboardEvent(connected, { type: "daemon-stopping" })).kind,
    ).toBe("reconnecting");
    expect(
      dashboardViewModel({ ...connected, phase: "failure", message: "socket failed" }),
    ).toEqual({ kind: "failure", message: "socket failed" });
  });

  test("reduces semantic events and preserves selection by Topic id across sorting", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_B, "Beta"), topic(ID_A, "Alpha")]),
    );
    state = handleDashboardInput(state, "j").state;
    expect(state.selectedTopicId).toBe(ID_B);
    state = reduceDashboardEvent(state, {
      type: "topic-changed",
      topic: topic(ID_B, "Aardvark"),
    });
    expect(state.topics[0]?.id).toBe(ID_B);
    expect(state.selectedTopicId).toBe(ID_B);
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "thinking", connected: true },
    });
    expect(state.mainAgents.find((agent) => agent.topicId === ID_B)?.state).toBe("thinking");
    state = reduceDashboardEvent(state, { type: "topic-removed", topicId: ID_B });
    expect(state.selectedTopicId).toBe(ID_A);
  });

  test("bubbles Topics with a running Main Agent above inactive ones and dims the inactive", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta")], [], {
        [ID_A]: { kind: "current" },
        [ID_B]: { kind: "current" },
      }),
    );
    // All Main Agents stopped: pure name order.
    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B]);

    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "thinking-sub", connected: true },
    });
    // Delegated thinking is active, so Beta bubbles above the inactive Alpha.
    expect(state.topics.map((item) => item.id)).toEqual([ID_B, ID_A]);

    const rendered = renderDashboard(state, 100, 24);
    const betaRow = rendered.find((line) => line.includes("Beta"));
    const alphaRow = rendered.find((line) => line.includes("Alpha"));
    // The inactive Topic is dimmed; the active one is not.
    expect(alphaRow).toContain("\x1b[2m");
    expect(betaRow).not.toContain("\x1b[2m");

    // A stopped Main Agent sinks the Topic back and re-dims it.
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "stopped", connected: false },
    });
    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  test("Focus partitions the list above active-agent bubbling, then Focused sort holds", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha", "ready", true), topic(ID_B, "Beta", "ready", false)]),
    );
    // Beta is Unfocused, so even a running Main Agent keeps it below the Focused Alpha.
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "thinking", connected: true },
    });
    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  test("shows an Orphan Topic in bright red and clears it from a live event", () => {
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([topic(ID_A, "Alpha")]),
      orphanedTopicIds: [ID_A],
    });

    const wide = renderDashboard(state, 100, 24).find((line) => line.includes("Alpha"));
    const narrow = renderDashboard(state, 40, 24).find((line) => line.includes("Alpha"));
    expect(stripSgr(wide!)).toContain("orphan");
    expect(stripSgr(narrow!)).toContain("orphan");
    expect(wide).toContain("\x1b[91morphan\x1b[39m");

    state = reduceDashboardEvent(state, {
      type: "worktree-presence-changed",
      topicId: ID_A,
      orphaned: false,
    });
    const restored = renderDashboard(state, 100, 24).find((line) => line.includes("Alpha"));
    expect(stripSgr(restored!)).not.toContain("orphan");
  });

  test("Shift+J Unfocuses and Shift+K Focuses the selection, following the moved Topic", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]),
    );
    // Unfocus Alpha: it sinks below Beta, selection follows, and an action is dispatched.
    const down = handleDashboardInput(state, "J");
    expect(down.action).toEqual({ type: "set-focus", topicId: ID_A, focused: false });
    state = down.state;
    expect(state.topics.map((item) => item.id)).toEqual([ID_B, ID_A]);
    expect(state.selectedTopicId).toBe(ID_A);
    expect(state.topics.find((item) => item.id === ID_A)?.focused).toBe(false);
    // Shift+J again is an idempotent no-op: no further action.
    expect(handleDashboardInput(state, "J").action).toBeUndefined();
    // Refocus Alpha: it rises back above Beta.
    const up = handleDashboardInput(state, "K");
    expect(up.action).toEqual({ type: "set-focus", topicId: ID_A, focused: true });
    state = up.state;
    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B]);
  });

  test("renders a blank separator only between a non-empty Focused and Unfocused part", () => {
    const both = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha", "ready", true), topic(ID_B, "Beta", "ready", false)]),
    );
    const rendered = renderDashboard(both, 100, 24);
    const alphaRow = rendered.findIndex((line) => line.includes("Alpha"));
    const betaRow = rendered.findIndex((line) => line.includes("Beta"));
    expect(rendered[betaRow - 1]?.trim()).toBe("");
    expect(betaRow).toBe(alphaRow + 2);

    // All Focused: no separator between the two rows.
    const allFocused = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]),
    );
    const rows = renderDashboard(allFocused, 100, 24);
    const a = rows.findIndex((line) => line.includes("Alpha"));
    const b = rows.findIndex((line) => line.includes("Beta"));
    expect(b).toBe(a + 1);
  });

  test("keeps the ambient style across the truncation ellipsis on a narrow, selected row", () => {
    // A long name at a narrow width forces truncateToWidth to insert an ellipsis. The
    // library emits a bare SGR reset (\x1b[0m) around that ellipsis, which would cancel
    // the ambient dim and highlight styles unless they are reopened after each reset.
    const longName = "AlphaTopicWithAVeryLongNameThatOverflows";
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, longName)]));
    state = { ...state, selectedTopicId: ID_A };
    // The inactive (stopped Main Agent) selected row is both dimmed and highlighted.
    const row = renderDashboard(state, 30, 24).find((line) => line.includes("Alpha"));
    expect(row).toBeDefined();
    // Every embedded full reset must reopen both the highlight background and the dim
    // attribute, so no reset is left bare (which would drop the colour past the ellipsis).
    const RESET = "\x1b[0m";
    const reopenCodes = ["\x1b[48;2;59;66;82m", "\x1b[2m", "\x1b[49m", "\x1b[22m"];
    const segments = row!.split(RESET);
    // Each split point (except the trailing one) is immediately followed by a reopen code.
    for (const after of segments.slice(1)) {
      expect(reopenCodes.some((code) => after.startsWith(code))).toBeTrue();
    }
    // The row must actually be truncated here, otherwise the guarantee is vacuous.
    expect(segments.length).toBeGreaterThan(1);
  });

  test("shimmers active Main Agent statuses with distinct colours", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    expect(hasShimmeringAgent(state)).toBeFalse();

    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking", connected: true },
    });
    expect(hasShimmeringAgent(state)).toBeTrue();

    // Thinking has a violet-white sweep, split into per-letter colour spans.
    const thinking = renderDashboard(state, 140, 24).find((line) => line.includes("Alpha"));
    expect(thinking).toContain("\x1b[38;5;231m");
    expect(thinking).not.toContain("thinking\x1b");

    // Advancing the phase moves the sweep, so the rendered row changes.
    const advanced = advanceShimmer(state);
    const second = renderDashboard(advanced, 140, 24).find((line) => line.includes("Alpha"));
    expect(second).not.toEqual(thinking);

    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking-sub", connected: true },
    });
    expect(mainAgentDisplayLabel("thinking-sub")).toBe("thinking (sub)");
    expect(hasShimmeringAgent(state)).toBeTrue();

    const wideDelegated = renderDashboard(state, 140, 24).find((line) => line.includes("Alpha"));
    const narrowDelegated = renderDashboard(state, 40, 24).find((line) => line.includes("Alpha"));
    expect(stripSgr(wideDelegated!)).toContain("thinking (sub)");
    expect(stripSgr(narrowDelegated!)).toContain("thinking (sub)");
    expect(wideDelegated).toContain("\x1b[38;5;231m");
    const advancedDelegated = renderDashboard(advanceShimmer(state), 140, 24).find((line) =>
      line.includes("Alpha"),
    );
    expect(advancedDelegated).not.toEqual(wideDelegated);

    const delegatedDetailState = handleDashboardInput(state, "\r").state;
    const delegatedDetail = renderDashboard(delegatedDetailState, 100, 24).join("\n");
    expect(stripSgr(delegatedDetail)).toContain("Main Agent: thinking (sub)");

    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "tracking-pr", connected: true },
    });
    expect(hasShimmeringAgent(state)).toBeTrue();
    // Tracking PR keeps the animation but uses a distinct blue-cyan sweep.
    const tracking = renderDashboard(state, 140, 24).find((line) => line.includes("Alpha"));
    expect(tracking).toContain("\x1b[38;5;195m");
    expect(tracking).not.toContain("tracking-pr\x1b");
    expect(tracking).not.toEqual(thinking);

    // The shared wrap lands on a loop boundary for both status-word lengths.
    let looped = state;
    for (let step = 0; step < SHIMMER_PERIOD; step += 1) looped = advanceShimmer(looped);
    expect(looped.shimmerPhase).toBe(state.shimmerPhase);
    const wrapped = renderDashboard(looped, 140, 24).find((line) => line.includes("Alpha"));
    expect(wrapped).toEqual(tracking);

    // A settled (idle) Main Agent stops the shimmer and needs no timer.
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "idle", connected: true },
    });
    expect(hasShimmeringAgent(state)).toBeFalse();
  });

  test("edits a Topic Note from the n shortcut and removes it with blank text", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha", "ready", true, "Waiting for Tom")]),
    );

    state = handleDashboardInput(state, "n").state;
    expect(state.note).toEqual({ topicId: ID_A, note: "Waiting for Tom" });
    state = handleDashboardInput(state, "\x7f").state;
    expect(state.note?.note).toBe("Waiting for To");

    state = { ...state, note: { topicId: ID_A, note: "  Ready\nfor review  " } };
    const saved = handleDashboardInput(state, "\r");
    expect(saved.action).toEqual({ type: "set-note", topicId: ID_A, note: "Ready for review" });

    const removing = handleDashboardInput(
      { ...saved.state, submissions: {}, note: { topicId: ID_A, note: "   " } },
      "\r",
    );
    expect(removing.action).toEqual({ type: "set-note", topicId: ID_A, note: "" });
  });

  test("rejects an oversized Topic Note without closing the editor", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = {
      ...handleDashboardInput(state, "n").state,
      note: { topicId: ID_A, note: "🙂".repeat(201) },
    };
    const result = handleDashboardInput(state, "\r");
    expect(result.action).toBeUndefined();
    expect(result.state.note?.error).toBe("Topic Note must be 200 characters or fewer.");
  });

  test("renders the Topic Note in a yellow column after the Topic title", () => {
    const state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha", "ready", true, "waiting for Tom")]),
    );
    const rendered = renderDashboard(state, 100, 24);
    const header = stripSgr(rendered[1]!);
    const wide = rendered.find((line) => line.includes("Alpha"))!;
    const visibleWide = stripSgr(wide);
    const noteIndex = header.indexOf("NOTE");
    expect(noteIndex).toBeGreaterThan(header.indexOf("TOPIC"));
    expect(noteIndex).toBeLessThan(header.indexOf("REPOSITORY"));
    expect(visibleWide.slice(noteIndex)).toStartWith("waiting for Tom");
    expect(wide).toContain("\x1b[33mwaiting for Tom\x1b[39m");

    const longNote = "x".repeat(80);
    const longState = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha", "ready", true, longNote)]),
    );
    const longRow = stripSgr(
      renderDashboard(longState, 220, 24).find((line) => line.includes("Alpha"))!,
    );
    expect(longRow).toContain(longNote);

    // The compact layout keeps the Note inline because it has no table columns.
    const narrow = renderDashboard(state, 30, 24).find((line) => line.includes("Alpha"))!;
    expect(visibleWidth(narrow)).toBeLessThanOrEqual(30);
    expect(stripSgr(narrow)).toContain("stopped");
    expect(narrow).toContain("\x1b[33m");
  });

  test("moves a Topic Note from the list column into the open detail view", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = handleDashboardInput(state, "l").state;
    let rendered = stripSgr(renderDashboard(state, 120, 24).join("\n"));
    expect(rendered).toContain("Add Note");
    expect(rendered).not.toContain("Note:");

    state = hydrateDashboard(
      state,
      snapshot([topic(ID_A, "Alpha", "ready", true, "private context")]),
    );
    const lines = renderDashboard(state, 160, 24);
    const listHeader = stripSgr(lines[1]!).split("│", 1)[0]!;
    const topicRow = lines.find((line) => line.includes("Alpha"))!.split("│", 1)[0]!;
    rendered = stripSgr(lines.join("\n"));

    expect(rendered).toContain("Edit Note");
    expect(listHeader).not.toContain("NOTE");
    expect(stripSgr(topicRow)).not.toContain("private context");
    expect(lines.join("\n")).toContain("Note: \x1b[33mprivate context\x1b[39m");
  });

  test("offers Copy Branch Name as the first Topic action", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));

    state = handleDashboardInput(state, "l").state;

    expect(state.focusedAction).toBe(0);
    expect(stripSgr(renderDashboard(state, 100, 24).join("\n"))).toContain("> Copy Branch Name");
    expect(handleDashboardInput(state, "\r").action).toEqual({
      type: "copy-branch",
      topicId: ID_A,
      branch: "feat-Alpha",
    });
  });

  test("opens the action rail on its first available action and supports navigation", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]),
    );
    state = handleDashboardInput(state, "\x1b[B").state;
    expect(state.selectedTopicId).toBe(ID_B);
    state = handleDashboardInput(state, "k").state;
    expect(state.selectedTopicId).toBe(ID_A);
    state = { ...state, unavailableActions: { [ID_A]: ["workspace"] } };
    state = handleDashboardInput(state, "l").state;
    expect(state.sidebarOpen).toBeTrue();
    expect(state.focus).toBe("actions");
    expect(state.focusedAction).toBe(0);
    state = handleDashboardInput(state, "h").state;
    expect(state.focus).toBe("detail");
    state = handleDashboardInput(state, "l").state;
    expect(state.focus).toBe("actions");
    state = handleDashboardInput(state, "\r").state;
    expect(state.sidebarOpen).toBeTrue();
    const close = handleDashboardInput(state, "q");
    expect(close.exit).toBeFalse();
    expect(close.state.sidebarOpen).toBeFalse();
    const reopened = handleDashboardInput(close.state, "l").state;
    expect(reopened.sidebarOpen).toBeTrue();
    expect(handleDashboardInput(reopened, "\x1b").exit).toBeTrue();
  });

  test("jumps directly from the Topic list to the selected Topic Main Agent", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));

    const result = handleDashboardInput(state, "m");

    expect(result.action).toEqual({ type: "agent", topicId: ID_A });
    expect(result.state).toMatchObject({
      focus: "list",
      sidebarOpen: false,
      submissions: { [ID_A]: "agent" },
      message: "Open Main Agent…",
    });
  });

  test("lets another Topic open its Main Agent while one Topic is provisioning", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([topic(ID_A, "Alpha"), topic(ID_B, "Beta", "provisioning")]),
    );
    // A create/retry submission for Beta occupies only its own key.
    state = { ...state, selectedTopicId: ID_A, submissions: { [ID_B]: "retry" } };

    const result = handleDashboardInput(state, "m");

    expect(result.action).toEqual({ type: "agent", topicId: ID_A });
  });

  test("blocks a second action on the same Topic while one is in flight", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = { ...state, selectedTopicId: ID_A, submissions: { [ID_A]: "terminal" } };

    expect(handleDashboardInput(state, "m").action).toBeUndefined();
  });

  test("offers a new Main Agent action in the action rail", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = handleDashboardInput(state, "l").state;
    for (let index = 0; index < 4; index += 1) state = handleDashboardInput(state, "j").state;

    expect(handleDashboardInput(state, "\r").action).toEqual({
      type: "reset-agent",
      topicId: ID_A,
    });
    expect(renderDashboard(state, 100, 24).join("\n")).toContain("Start New Main Agent");
  });

  test("does not jump to an unavailable Main Agent", () => {
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([topic(ID_A, "Alpha")]),
      deniedActions: { [ID_A]: ["agent.open"] },
    });

    expect(handleDashboardInput(state, "m").action).toBeUndefined();
  });

  test("jumps directly from the Topic list to the selected Topic workspace", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));

    const result = handleDashboardInput(state, "o");

    expect(result.action).toEqual({ type: "workspace", topicId: ID_A });
    expect(result.state).toMatchObject({
      focus: "list",
      sidebarOpen: false,
      submissions: { [ID_A]: "workspace" },
      message: "Access Topic Workspace…",
    });
  });

  test("does not jump to an unavailable workspace", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = { ...state, unavailableActions: { [ID_A]: ["workspace"] } };

    expect(handleDashboardInput(state, "o").action).toBeUndefined();
  });

  test("moves through actions with Vim and arrow keys and creates typed invocations", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = handleDashboardInput(state, "l").state;
    expect(state.focus).toBe("actions");
    state = handleDashboardInput(state, "j").state;
    state = handleDashboardInput(state, "j").state;
    expect(state.focusedAction).toBe(2);
    const terminal = handleDashboardInput(state, "\r");
    expect(terminal.action).toEqual({ type: "terminal", topicId: ID_A });

    const readyState = { ...terminal.state, submissions: {} };
    state = handleDashboardInput(readyState, "\x1b[A").state;
    expect(state.focusedAction).toBe(1);
    expect(handleDashboardInput(state, "\r").action).toEqual({
      type: "workspace",
      topicId: ID_A,
    });
  });

  test("makes daemon-denied actions unavailable without invocation", () => {
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([topic(ID_A, "Alpha")]),
      deniedActions: { [ID_A]: ["terminal.open", "agent.open", "topic.delete"] },
    });
    state = handleDashboardInput(state, "l").state;
    state = handleDashboardInput(state, "l").state;
    state = handleDashboardInput(state, "j").state;
    state = handleDashboardInput(state, "j").state;
    expect(handleDashboardInput(state, "\r").action).toBeUndefined();
    const rendered = renderDashboard(state, 100, 24).join("\n");
    expect(rendered).toContain("Open Terminal · unavailable");
    expect(rendered).toContain("Open Main Agent · unavailable");
    expect(rendered).toContain("Delete Topic · unavailable");
  });

  test("renders complete Topic details and live Main Agent and workspace states", () => {
    let state = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_A, "Alpha")]));
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking", connected: true },
    });
    state = reduceDashboardEvent(state, {
      type: "terminal-opened",
      topicId: ID_A,
      result: { kind: "launched", workspace: 4, message: "Opened." },
    });
    state = handleDashboardInput(state, "\r").state;
    const detail = renderDashboard(state, 100, 24).join("\n");
    expect(detail).toContain("Base: /base/alpha");
    expect(detail).toContain("Worktree: /work/Alpha");
    // A thinking Main Agent shimmers, so the label is a per-letter colour sweep, not plain text.
    expect(detail).toContain("Main Agent: \x1b[38;5;231mt\x1b[39m");
    expect(detail).toContain("Workspace: 4");

    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "tracking-pr", connected: true },
    });
    const trackingDetail = renderDashboard(state, 100, 24).join("\n");
    expect(trackingDetail).toContain("Main Agent: \x1b[38;5;195mt\x1b[39m");
    expect(trackingDetail).not.toContain("tracking-pr\x1b");

    for (const agentState of ["waiting-for-human", "stopped"] as const) {
      state = reduceDashboardEvent(state, {
        type: "main-agent-changed",
        agent: { topicId: ID_A, sessionId: ID_A, state: agentState, connected: false },
      });
      expect(renderDashboard(state, 100, 24).join("\n")).toContain(`Main Agent: ${agentState}`);
    }
  });

  test("gives spare table width to Topic names and right-aligns Main Agent status", () => {
    const alpha = { ...topic(ID_A, "Alpha"), repository: "o/a" };
    let state = hydrateDashboard(initialDashboardState(), snapshot([alpha]));
    const shortHeader = stripSgr(renderDashboard(state, 100, 24)[1]!);
    const shortRow = stripSgr(
      renderDashboard(state, 100, 24).find((line) => line.includes("Alpha"))!,
    );

    // Header-sized auxiliary columns leave 67 cells for the Topic name.
    expect(shortHeader.indexOf("REPOSITORY")).toBe(70);
    expect(shortRow).toHaveLength(100);
    expect(shortRow.endsWith("stopped")).toBeTrue();

    const beta = {
      ...topic(ID_B, "Beta", "setup-failed"),
      repository: "owner/a-repository-name-beyond-the-cap",
    };
    state = hydrateDashboard(state, snapshot([alpha, beta]));
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "waiting-for-human", connected: true },
    });
    const cappedHeader = stripSgr(renderDashboard(state, 100, 24)[1]!);
    const betaRow = stripSgr(
      renderDashboard(state, 100, 24).find((line) => line.includes("Beta"))!,
    );

    // Auxiliary values grow only to their caps. The Repository cap is wide enough for
    // common owner/repo names, and the Topic name still gets every spare cell.
    expect(cappedHeader.indexOf("REPOSITORY")).toBe(34);
    expect(betaRow).toContain("owner/a-repository-name");
    expect(betaRow).toHaveLength(100);
    expect(betaRow.endsWith("waiting-for-human")).toBeTrue();
  });

  test("renders exact Topic name prefixes as a visible hierarchy", () => {
    const parent = topic(ID_A, "Tokenization");
    const child = topic(ID_B, "Tokenization > 01 - Templates");
    const grandchild = topic(ID_C, "Tokenization > 01 - Templates > Tests");
    const sibling = topic(ID_D, "Tokenization > 02 - Validation");
    const otherFamily = topic(ID_E, "Alpha");
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([parent, child, grandchild, sibling, otherFamily]),
    );

    const tree = stripSgr(renderDashboard(state, 120, 24).join("\n"));
    expect(tree).toContain(`${UNKNOWN_GLYPH}   ├─ 01 - Templates`);
    expect(tree).toContain(`${UNKNOWN_GLYPH}   │  └─ Tests`);
    expect(tree).toContain(`${UNKNOWN_GLYPH}   └─ 02 - Validation`);
    expect(tree).not.toContain("Tokenization > 01");

    // An active child bubbles its whole family, but it stays below its parent.
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_B, sessionId: ID_B, state: "thinking", connected: true },
    });
    expect(state.topics.map((topic) => topic.id)).toEqual([ID_A, ID_B, ID_C, ID_D, ID_E]);
    const activeTree = stripSgr(renderDashboard(state, 120, 24).join("\n"));
    expect(activeTree).toContain(`${UNKNOWN_GLYPH}   ├─ 01 - Templates`);
    expect(activeTree).not.toContain("Tokenization > 01");
  });

  test("orders a durable family by Integration Chain and keeps pending children in place", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_C },
    });
    // Alphabetical order would put alpha first; the Integration Chain keeps zeta first.
    const zeta = familyTopic(ID_B, "zeta", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const alpha = familyTopic(ID_C, "alpha", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const pending = familyTopic(ID_D, "pending-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_B },
      chainState: "pending",
      setup: "provisioning",
    });
    const state = hydrateDashboard(
      initialDashboardState(),
      snapshot([alpha, parent, pending, zeta], [], {
        [ID_A]: { kind: "current" },
        [ID_B]: { kind: "current" },
        [ID_C]: { kind: "behind", target: "zeta", ahead: 2, behind: 1 },
      }),
    );

    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B, ID_D, ID_C]);
    const tree = stripSgr(renderDashboard(state, 120, 24).join("\n"));
    expect(tree).toContain("  ├─ zeta");
    expect(tree).toContain("  ├─ pending-child");
    expect(tree).toContain("  └─ alpha");
  });

  test("colours the first broken chain edge and leaves later current edges green", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_C },
    });
    const first = familyTopic(ID_B, "first", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const second = familyTopic(ID_C, "second", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const pending = familyTopic(ID_D, "pending-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_C },
      chainState: "pending",
      setup: "setup-failed",
    });
    const state = hydrateDashboard(
      initialDashboardState(),
      snapshot([parent, first, second, pending], [], {
        [ID_A]: { kind: "current" },
        [ID_B]: { kind: "conflict", target: "main", behind: 3 },
        [ID_C]: { kind: "current" },
      }),
    );
    const rows = renderDashboard(state, 120, 24);
    const rowOf = (name: string) => rows.find((line) => line.includes(name))!;

    expect(stripSgr(rows[1]!)).toStartWith(`  ${INTEGRATION_HEADER} TOPIC`);
    expect(stripSgr(rowOf("first")).slice(2)).toStartWith(`${CONFLICT_GLYPH}   ├─ first`);
    expect(rowOf("first")).toContain(`\x1b[31m${CONFLICT_GLYPH}`);
    expect(rowOf("second")).toContain(`\x1b[32m${CURRENT_GLYPH}`);
    expect(rowOf("Parent")).toContain(`\x1b[32m${CURRENT_GLYPH}`);
    // A setup-failed pending child keeps its position and reads Unknown.
    expect(stripSgr(rowOf("pending-child")).slice(2)).toStartWith(
      `${UNKNOWN_GLYPH}   └─ pending-child`,
    );
    expect(state.topics.map((item) => item.id)).toEqual([ID_A, ID_B, ID_C, ID_D]);
  });

  test("shows textual Integration Status, Branch, counts, and a bounded diagnostic", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const child = familyTopic(ID_B, "child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
      chainState: "pending",
    });
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([parent, child], [], {
        [ID_B]: {
          kind: "behind",
          target: "main",
          ahead: 4,
          behind: 2,
          detail: "The Integration Target has new commits.",
        },
      }),
      integrationBranches: { [parent.repository]: "main" },
    });
    state = { ...state, selectedTopicId: ID_B, sidebarOpen: true };

    const detail = stripSgr(renderDashboard(state, 260, 40).join("\n"));
    expect(detail).toContain(
      "Integration: Behind · target main · ahead 4 · behind 2 · pending insertion",
    );
    expect(detail).toContain("Integration Branch: main");
    expect(detail).toContain("Parent Topic: Parent");
    expect(detail).toContain("Integration detail: The Integration Target has new commits.");
  });

  test("offers Add Child Topic on a Parent Topic only", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const child = familyTopic(ID_B, "child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    let state = hydrateDashboard(initialDashboardState(), snapshot([parent, child]));
    state = { ...state, selectedTopicId: ID_A, sidebarOpen: true, focus: "actions" };
    expect(stripSgr(renderDashboard(state, 120, 40).join("\n"))).toContain("Add Child Topic");

    const onChild = { ...state, selectedTopicId: ID_B };
    expect(stripSgr(renderDashboard(onChild, 120, 40).join("\n"))).not.toContain("Add Child Topic");
  });

  test("offers only the chain maintenance actions that the daemon can accept", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_C },
    });
    const first = familyTopic(ID_B, "first-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const second = familyTopic(ID_C, "second-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const other = familyTopic(ID_D, "Other root", {
      integrationTarget: { kind: "integration-branch" },
    });
    let state = hydrateDashboard(initialDashboardState(), snapshot([parent, first, second, other]));
    state = { ...state, selectedTopicId: ID_B, sidebarOpen: true, focus: "actions" };

    const onChild = stripSgr(renderDashboard(state, 120, 40).join("\n"));
    expect(onChild).toContain("Change Parent Topic");
    expect(onChild).toContain("Remove Parent Topic");
    expect(onChild).toContain("Move in Integration Chain");
    expect(onChild).not.toContain("Reset Integration Target");

    const onParent = stripSgr(
      renderDashboard({ ...state, selectedTopicId: ID_A }, 120, 40).join("\n"),
    );
    expect(onParent).toContain("Reset Integration Target");
    // A Parent Topic keeps its children, so it can never join another family.
    expect(onParent).not.toContain("Change Parent Topic");
    expect(onParent).not.toContain("Remove Parent Topic");

    // A root Topic without a family offers no chain repair at all.
    const alone = hydrateDashboard(initialDashboardState(), snapshot([topic(ID_E, "Alpha")]));
    const onAlone = stripSgr(
      renderDashboard(
        { ...alone, selectedTopicId: ID_E, sidebarOpen: true, focus: "actions" },
        120,
        40,
      ).join("\n"),
    );
    expect(onAlone).not.toContain("Change Parent Topic");
    expect(onAlone).not.toContain("Reset Integration Target");
  });

  test("submits one chain move from the side-view chooser and cancels on escape", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_C },
    });
    const first = familyTopic(ID_B, "first-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const second = familyTopic(ID_C, "second-child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    let state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([parent, first, second]),
      integrationBranches: { "owner/family": "main" },
    });
    state = { ...state, selectedTopicId: ID_B, sidebarOpen: true, focus: "actions" };
    // Walk the action rail to Move in Integration Chain.
    let opened = { state, exit: false } as ReturnType<typeof handleDashboardInput>;
    for (let step = 0; step < 20; step += 1) {
      const view = stripSgr(renderDashboard(opened.state, 120, 40).join("\n"));
      if (view.includes("> Move in Integration Chain")) break;
      opened = handleDashboardInput(opened.state, "j");
    }
    opened = handleDashboardInput(opened.state, "\r");
    const chooser = stripSgr(renderDashboard(opened.state, 120, 40).join("\n"));
    expect(chooser).toContain("MOVE IN INTEGRATION CHAIN");
    expect(chooser).toContain("main (first in the chain)");
    expect(chooser).toContain("After second-child");

    const cancelled = handleDashboardInput(opened.state, "\x1b");
    expect(cancelled.state.chainPicker).toBeUndefined();
    expect(cancelled.action).toBeUndefined();

    const moved = handleDashboardInput(handleDashboardInput(opened.state, "j").state, "\r");
    expect(moved.action).toEqual({
      type: "move-in-chain",
      topicId: ID_B,
      target: { kind: "topic", topicId: ID_C },
    });
    expect(moved.state.chainPicker).toBeUndefined();
  });

  test("offers legacy migration only while an unresolved legacy family exists", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "integration-branch" },
    });
    const legacy = hydrateDashboard(initialDashboardState(), {
      ...snapshot([parent]),
      legacyFamilies: 1,
    });
    const state = {
      ...legacy,
      selectedTopicId: ID_A,
      sidebarOpen: true,
      focus: "actions" as const,
    };
    expect(stripSgr(renderDashboard(state, 120, 40).join("\n"))).toContain(
      "Migrate Legacy Name Hierarchies",
    );

    const migrated = hydrateDashboard(initialDashboardState(), {
      ...snapshot([parent]),
      legacyFamilies: 0,
    });
    expect(
      stripSgr(
        renderDashboard(
          { ...migrated, selectedTopicId: ID_A, sidebarOpen: true, focus: "actions" },
          120,
          40,
        ).join("\n"),
      ),
    ).not.toContain("Migrate Legacy Name Hierarchies");
  });

  test("shows every proposal and skipped Topic, and needs explicit approval", () => {
    const parent = familyTopic(ID_A, "Parent", {});
    const child = familyTopic(ID_B, "Parent > child", {});
    const stranger = familyTopic(ID_C, "Other > lost", {});
    const state = hydrateDashboard(initialDashboardState(), {
      ...snapshot([parent, child, stranger]),
      legacyFamilies: 1,
    });
    const opened = openMigrationPreview(state, {
      families: [
        {
          parentTopicId: ID_A,
          children: [{ topicId: ID_B, integrationTarget: { kind: "integration-branch" } }],
          parentIntegrationTarget: { kind: "topic", topicId: ID_B },
        },
      ],
      skipped: [{ topicId: ID_C, code: "no-parent-match", message: 'No Topic is named "Other".' }],
    });
    const view = stripSgr(renderDashboard(opened, 120, 40).join("\n"));
    expect(view).toContain("MIGRATE LEGACY NAME HIERARCHIES");
    expect(view).toContain("Parent Topic Parent");
    expect(view).toContain("child Parent > child");
    expect(view).toContain("no-parent-match");
    expect(view).toContain("enter approve");

    const cancelled = handleDashboardInput(opened, "\x1b");
    expect(cancelled.action).toBeUndefined();
    expect(cancelled.state.migration).toBeUndefined();

    const approved = handleDashboardInput(opened, "\r");
    expect(approved.action).toEqual({ type: "migrate-legacy", parentTopicIds: [ID_A] });
    expect(approved.state.migration).toBeUndefined();
  });

  test("submits one Change Parent Topic from the side-view chooser", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const child = familyTopic(ID_B, "child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const adopter = familyTopic(ID_D, "Adopter", {
      integrationTarget: { kind: "integration-branch" },
    });
    let state = hydrateDashboard(initialDashboardState(), snapshot([parent, child, adopter]));
    state = {
      ...state,
      selectedTopicId: ID_B,
      chainPicker: { topicId: ID_B, kind: "change-parent", index: 0 },
    };

    const chooser = stripSgr(renderDashboard(state, 120, 40).join("\n"));
    expect(chooser).toContain("CHANGE PARENT TOPIC");
    expect(chooser).toContain("Adopter");
    // The current Parent Topic is never offered again.
    expect(chooser).not.toContain("> Parent");

    const submitted = handleDashboardInput(state, "\r");
    expect(submitted.action).toEqual({
      type: "change-parent",
      topicId: ID_B,
      parentTopicId: ID_D,
    });
  });

  test("Focus and Unfocus move the complete family and keep the selection", () => {
    const parent = familyTopic(ID_A, "Parent", {
      integrationTarget: { kind: "topic", topicId: ID_B },
    });
    const child = familyTopic(ID_B, "child", {
      parentTopicId: ID_A,
      integrationTarget: { kind: "integration-branch" },
    });
    const other = topic(ID_E, "Alpha");
    let state = hydrateDashboard(initialDashboardState(), snapshot([parent, child, other]));
    state = { ...state, selectedTopicId: ID_B };

    const unfocused = handleDashboardInput(state, "J");
    expect(unfocused.action).toEqual({ type: "set-focus", topicId: ID_B, focused: false });
    expect(unfocused.state.selectedTopicId).toBe(ID_B);
    expect(unfocused.state.topics.filter((item) => !item.focused).map((item) => item.id)).toEqual([
      ID_A,
      ID_B,
    ]);
    // The family stays together above the separator again after Focus.
    const refocused = handleDashboardInput(unfocused.state, "K");
    expect(refocused.state.topics.every((item) => item.focused)).toBeTrue();
    expect(refocused.state.topics.map((item) => item.id)).toEqual([ID_E, ID_A, ID_B]);
  });

  test("renders narrow and wide dashboards without exceeding terminal width", () => {
    let state = hydrateDashboard(
      initialDashboardState(),
      snapshot([
        topic(ID_A, "A-very-long-Topic-name-that-must-be-truncated"),
        topic(ID_B, "Beta", "setup-failed"),
      ]),
    );
    state = reduceDashboardEvent(state, {
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking-sub", connected: true },
    });
    state = handleDashboardInput(state, "\r").state;
    for (const [width, height] of [
      [28, 12],
      [120, 30],
    ] as const) {
      const lines = renderDashboard(state, width, height);
      expect(lines).toHaveLength(height);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBeTrue();
    }
  });
});

class FakeDashboardClient implements DashboardClient {
  closed = 0;
  handler: ((event: WorkEvent) => void) | undefined;
  disconnect: ((error: Error) => void) | undefined;
  createCalls: Array<{ input: NewTopic; requestId?: string }> = [];
  createChildCalls: Array<{ input: ResolvedChildTopicCreationInput; requestId?: string }> = [];
  retryCalls: Array<{ topicId: string; requestId?: string }> = [];
  renameCalls: Array<{ topicId: string; name: string; requestId?: string }> = [];
  noteCalls: Array<{ topicId: string; note: string; requestId?: string }> = [];
  setFocusCalls: Array<{ topicId: string; focused: boolean; requestId?: string }> = [];
  actionCalls: Array<{
    type: "delete" | "workspace" | "terminal" | "agent" | "reset-agent" | "pull-request";
    topicId: string;
    requestId?: string;
  }> = [];
  chainCalls: Array<{
    type: "change-parent" | "remove-parent" | "move-in-chain" | "reset-chain";
    topicId: string;
    parentTopicId?: string;
    target?: IntegrationTarget;
    requestId?: string;
  }> = [];
  migrationCalls: Array<{
    type: "preview" | "apply";
    parentTopicIds?: readonly string[];
    requestId?: string;
  }> = [];
  migrationPreview: LegacyMigrationPreview = { families: [], skipped: [] };
  legacyFamilies = 0;
  confirmCalls: Array<{ token: string; requestId?: string }> = [];
  rejectCalls: Array<{ token: string; requestId?: string }> = [];
  snapshotCalls = 0;
  refreshCalls = 0;
  chainResult: TopicMutationResult = { status: "chain-changed", topic: topic(ID_A, "Alpha") };
  createResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  retryResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  renameResult: TopicMutationResult = { status: "renamed", topic: topic(ID_A, "Alpha") };
  noteResult: TopicMutationResult = { status: "note-updated", topic: topic(ID_A, "Alpha") };
  confirmResult: TopicMutationResult = { status: "ready", topic: topic(ID_A, "Alpha") };
  rejectResult: TopicMutationResult = { status: "rejected", topicId: ID_A };
  private readonly topics: readonly TopicManifest[];
  knownRepositories: readonly string[] = [];

  constructor(topics: readonly TopicManifest[] = [topic(ID_A, "Alpha")]) {
    this.topics = topics;
  }

  async snapshot(): Promise<DaemonSnapshot> {
    this.snapshotCalls += 1;
    return {
      ...snapshot(this.topics, this.knownRepositories),
      legacyFamilies: this.legacyFamilies,
    };
  }

  async refresh(): Promise<{ refreshed: boolean }> {
    this.refreshCalls += 1;
    return { refreshed: true };
  }

  async subscribe(handler: (event: WorkEvent) => void): Promise<void> {
    this.handler = handler;
  }

  async createTopic(input: NewTopic, requestId?: string): Promise<TopicMutationResult> {
    this.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
    return this.createResult;
  }

  async createChildTopic(
    input: ResolvedChildTopicCreationInput,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.createChildCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
    return this.createResult;
  }

  async retryTopic(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.retryCalls.push({ topicId, ...(requestId === undefined ? {} : { requestId }) });
    return this.retryResult;
  }

  async renameTopic(
    topicId: string,
    name: string,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.renameCalls.push({ topicId, name, ...(requestId === undefined ? {} : { requestId }) });
    return this.renameResult;
  }

  async setTopicNote(
    topicId: string,
    note: string,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.noteCalls.push({ topicId, note, ...(requestId === undefined ? {} : { requestId }) });
    return this.noteResult;
  }

  async setTopicFocus(
    topicId: string,
    focused: boolean,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.setFocusCalls.push({
      topicId,
      focused,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { status: "refocused", topic: { ...topic(topicId, "Alpha"), focused } };
  }

  async deleteTopic(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.actionCalls.push({
      type: "delete",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return {
      status: "confirmation-required",
      token: "delete-token",
      action: "topic.delete",
      topicId,
      expiresAt: "2026-01-01T00:01:00.000Z",
      text: "Delete only this local Topic record? The branch, worktree, base checkout, Pi session, and open windows will remain.",
    };
  }

  async changeTopicParent(
    topicId: string,
    parentTopicId: string,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.chainCalls.push({
      type: "change-parent",
      topicId,
      parentTopicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return this.chainResult;
  }

  async removeTopicParent(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.chainCalls.push({
      type: "remove-parent",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return this.chainResult;
  }

  async moveTopicInChain(
    topicId: string,
    target: IntegrationTarget,
    requestId?: string,
  ): Promise<TopicMutationResult> {
    this.chainCalls.push({
      type: "move-in-chain",
      topicId,
      target,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return this.chainResult;
  }

  async resetIntegrationTargets(topicId: string, requestId?: string): Promise<TopicMutationResult> {
    this.chainCalls.push({
      type: "reset-chain",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return this.chainResult;
  }

  async previewLegacyMigration(requestId?: string): Promise<LegacyMigrationPreviewResult> {
    this.migrationCalls.push({
      type: "preview",
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { status: "migration-preview", preview: this.migrationPreview };
  }

  async applyLegacyMigration(
    parentTopicIds?: readonly string[],
    requestId?: string,
  ): Promise<LegacyMigrationApplyResult> {
    this.migrationCalls.push({
      type: "apply",
      ...(parentTopicIds === undefined ? {} : { parentTopicIds }),
      ...(requestId === undefined ? {} : { requestId }),
    });
    return {
      status: "migration-applied",
      migrationId: "run-1",
      appliedParentTopicIds: parentTopicIds ?? [],
      rolledBackParentTopicIds: [],
      skipped: [],
    };
  }

  async accessWorkspace(topicId: string, requestId?: string): Promise<WorkspaceActionResult> {
    this.actionCalls.push({
      type: "workspace",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "focused", workspace: 3, message: "Focused Topic workspace 3." };
  }

  async openTerminal(topicId: string, requestId?: string): Promise<WorkActionResult> {
    this.actionCalls.push({
      type: "terminal",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Opened Topic terminal on workspace 3." };
  }

  async openMainAgent(
    topicId: string,
    requestId?: string,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    this.actionCalls.push({
      type: "agent",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Opened Main Agent on workspace 3." };
  }

  async resetMainAgent(
    topicId: string,
    requestId?: string,
  ): Promise<MainAgentActionResult | WorkActionResult> {
    this.actionCalls.push({
      type: "reset-agent",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "launched", workspace: 3, message: "Started a new Main Agent." };
  }

  async openPullRequest(topicId: string, requestId?: string): Promise<WorkActionResult> {
    this.actionCalls.push({
      type: "pull-request",
      topicId,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return { kind: "opened", message: "Opened the pull request in a browser." };
  }

  async confirm(token: string, requestId?: string): Promise<WorkActionResult> {
    this.confirmCalls.push({ token, ...(requestId === undefined ? {} : { requestId }) });
    return this.confirmResult;
  }

  async reject(token: string, requestId?: string): Promise<TopicMutationResult> {
    this.rejectCalls.push({ token, ...(requestId === undefined ? {} : { requestId }) });
    return this.rejectResult;
  }

  onDisconnect(handler: (error: Error) => void): () => void {
    this.disconnect = handler;
    return () => {
      this.disconnect = undefined;
    };
  }

  close(): void {
    this.closed += 1;
  }
}

describe("dashboard submission behavior", () => {
  test("normalizes pasted line breaks and saves a Topic Note", async () => {
    const client = new FakeDashboardClient();
    client.noteResult = {
      status: "note-updated",
      topic: topic(ID_A, "Alpha", "ready", true, "waiting for Tom"),
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("n");
    component.handleInput("\x1b[200~  waiting\nfor Tom  \x1b[201~");
    expect(component.snapshotState().note?.note).toBe("  waiting for Tom  ");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.noteCalls).toHaveLength(1);
    expect(client.noteCalls[0]).toMatchObject({ topicId: ID_A, note: "waiting for Tom" });
    expect(component.snapshotState().message).toBe("Topic Note saved.");
    component.dispose();
  });

  test("returns to the dashboard, selects the added Topic, and prevents duplicate create", async () => {
    const client = new FakeDashboardClient([]);
    let finish!: (result: TopicMutationResult) => void;
    client.createTopic = async (input, requestId) => {
      client.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
      return new Promise<TopicMutationResult>((resolve) => {
        finish = resolve;
      });
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta-custom", "owner/beta");
    expect(component.snapshotState().wizard).toBeUndefined();
    expect(client.createCalls).toHaveLength(1);
    component.handleInput("a");
    component.handleInput("\r");
    expect(client.createCalls).toHaveLength(1);

    const provisioning = topic(ID_B, "Beta", "provisioning");
    client.handler?.({ type: "topic-added", topic: provisioning });
    expect(component.snapshotState().selectedTopicId).toBe(ID_B);
    expect(component.snapshotState().topics[0]?.setup.state).toBe("provisioning");
    client.handler?.({ type: "setup-changed", topic: topic(ID_B, "Beta", "ready") });
    expect(component.snapshotState().topics[0]?.setup.state).toBe("ready");
    client.handler?.({ type: "setup-changed", topic: topic(ID_B, "Beta", "setup-failed") });
    component.handleInput("\r");
    const failedDetails = renderDashboard(component.snapshotState(), 100, 20).join("\n");
    expect(failedDetails).toContain("setup-failed");
    expect(failedDetails).toContain("wt failed");
    finish({ status: "failed", reason: "wt failed", topic: topic(ID_B, "Beta", "setup-failed") });
    await Bun.sleep(0);
    expect(component.snapshotState().submissions).toEqual({});
    component.dispose();
  });

  test("uses one stable request id when a transport reconnect retries create", async () => {
    const first = new FakeDashboardClient([]);
    first.createTopic = async (input, requestId) => {
      first.createCalls.push({ input, ...(requestId === undefined ? {} : { requestId }) });
      return new Promise<TopicMutationResult>(() => undefined);
    };
    const second = new FakeDashboardClient([]);
    const clients = [first, second];
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
      connect: async () => clients.shift()!,
      done: () => undefined,
    });
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta", "owner/beta");
    first.disconnect?.(new Error("socket lost"));
    await Bun.sleep(0);
    expect(first.createCalls).toHaveLength(1);
    expect(second.createCalls).toHaveLength(1);
    expect(second.createCalls[0]?.requestId).toBe(first.createCalls[0]?.requestId);
    component.dispose();
  });

  test("shows exact ask action and supports approve, reject, and deny", async () => {
    const ask = new FakeDashboardClient([]);
    ask.createResult = {
      status: "confirmation-required",
      token: "token-1",
      action: "repository.clone",
      topicId: ID_B,
      expiresAt: "2026-01-01T00:01:00.000Z",
      text: "Allow repository.clone for Topic Beta?",
    };
    const component = dashboardComponent(ask);
    await Bun.sleep(0);
    enterWizard(component, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    expect(component.render(80).join("\n")).toContain("Allow repository.clone for Topic Beta?");
    component.handleInput("y");
    await Bun.sleep(0);
    expect(ask.confirmCalls[0]?.token).toBe("token-1");
    component.dispose();

    const reject = new FakeDashboardClient([]);
    reject.createResult = { ...ask.createResult, token: "token-2" };
    const rejected = dashboardComponent(reject);
    await Bun.sleep(0);
    enterWizard(rejected, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    rejected.handleInput("n");
    await Bun.sleep(0);
    expect(reject.rejectCalls[0]?.token).toBe("token-2");
    rejected.dispose();

    const deny = new FakeDashboardClient([]);
    deny.createResult = {
      status: "denied",
      reason: "Policy denied repository.clone.",
      topic: topic(ID_B, "Beta", "setup-failed"),
    };
    const denied = dashboardComponent(deny);
    await Bun.sleep(0);
    enterWizard(denied, "Beta", "beta", "owner/beta");
    await Bun.sleep(0);
    expect(denied.snapshotState().message).toBe("Policy denied repository.clone.");
    denied.dispose();
  });

  test("invokes workspace actions and shows workspace exhaustion as information", async () => {
    const client = new FakeDashboardClient();
    client.openTerminal = async (topicId, requestId) => {
      client.actionCalls.push({
        type: "terminal",
        topicId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return {
        kind: "unavailable",
        message: "No empty workspace is available in the temporary pool (1-10).",
      };
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.actionCalls[0]?.type).toBe("terminal");
    expect(component.snapshotState().message).toContain("No empty workspace");
    expect(component.snapshotState().phase).toBe("connected");
    component.dispose();
  });

  test("starts a new Main Agent from the action rail", async () => {
    const client = new FakeDashboardClient();
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    for (let index = 0; index < 4; index += 1) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(client.actionCalls[0]?.type).toBe("reset-agent");
    expect(component.snapshotState().message).toBe("Started a new Main Agent.");
    component.dispose();
  });

  test("previews the legacy migration and applies it only after approval", async () => {
    const client = new FakeDashboardClient();
    client.legacyFamilies = 1;
    client.migrationPreview = {
      families: [
        {
          parentTopicId: ID_A,
          children: [],
          parentIntegrationTarget: { kind: "integration-branch" },
        },
      ],
      skipped: [],
    };
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    for (let step = 0; step < 8; step += 1) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.migrationCalls.map((call) => call.type)).toEqual(["preview"]);
    expect(component.snapshotState().migration?.preview.families).toHaveLength(1);

    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.migrationCalls.map((call) => call.type)).toEqual(["preview", "apply"]);
    expect(client.migrationCalls[1]?.parentTopicIds).toEqual([ID_A]);
    expect(component.snapshotState().migration).toBeUndefined();
    component.dispose();
  });

  test("retries an in-flight workspace action after reconnect with the same request id", async () => {
    const first = new FakeDashboardClient();
    first.openTerminal = async (topicId, requestId) => {
      first.actionCalls.push({
        type: "terminal",
        topicId,
        ...(requestId === undefined ? {} : { requestId }),
      });
      return new Promise<WorkActionResult>(() => undefined);
    };
    const second = new FakeDashboardClient();
    const clients = [first, second];
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
      connect: async () => clients.shift()!,
      done: () => undefined,
    });
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    first.disconnect?.(new Error("socket lost"));
    await Bun.sleep(0);
    expect(second.actionCalls[0]?.type).toBe("terminal");
    expect(second.actionCalls[0]?.requestId).toBe(first.actionCalls[0]?.requestId);
    component.dispose();
  });

  test("shows policy denial as an unavailable action", async () => {
    const client = new FakeDashboardClient();
    client.openTerminal = async () => ({
      status: "denied",
      reason: "Policy denied terminal.open.",
      topic: topic(ID_A, "Alpha"),
    });
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(component.render(100).join("\n")).toContain("Open Terminal · unavailable");
    component.dispose();
  });

  test("shows the manifest-only delete warning and keeps nearest selection after deletion", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha"), topic(ID_B, "Beta")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("l");
    component.handleInput("l");
    // Actions: copy, workspace, terminal, agent, reset-agent, rename, note, add-child, delete.
    for (let step = 0; step < 8; step += 1) component.handleInput("j");
    component.handleInput("\r");
    await Bun.sleep(0);
    const warning = component.render(180).join("\n");
    expect(warning).toContain("branch, worktree, base checkout, Pi session, and open windows");
    client.handler?.({ type: "topic-removed", topicId: ID_A });
    expect(component.snapshotState().selectedTopicId).toBe(ID_B);
    component.dispose();
  });

  test("offers Retry Setup for failed and interrupted Topics", async () => {
    for (const setup of ["setup-failed", "provisioning"] as const) {
      const client = new FakeDashboardClient([topic(ID_A, "Alpha", setup)]);
      const component = dashboardComponent(client);
      await Bun.sleep(0);
      component.handleInput("\r");
      const rail = component.render(80).join("\n");
      expect(rail).toContain("Retry Setup");
      expect(rail).not.toContain("Retry Setup (r)");
      // Actions: copy, workspace, terminal, agent, reset-agent, rename, note, retry, delete.
      for (let i = 0; i < 7; i += 1) component.handleInput("j");
      expect(component.snapshotState().focusedAction).toBe(7);
      component.handleInput("\r");
      await Bun.sleep(0);
      expect(client.retryCalls).toHaveLength(1);
      component.dispose();
    }
  });

  test("r refreshes local state and starts a pull request refresh", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha", "setup-failed")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    const before = client.snapshotCalls;
    // Opening the dashboard already refreshed daemon state once.
    expect(client.refreshCalls).toBe(1);
    component.handleInput("r");
    await Bun.sleep(0);
    expect(client.refreshCalls).toBe(2);
    expect(client.snapshotCalls).toBe(before + 1);
    expect(client.retryCalls).toHaveLength(0);
    expect(component.render(80).join("\n")).toContain(
      "Local repository state refreshed; pull requests are updating.",
    );
    component.dispose();
  });

  test("copies the exact Branch name from the first Topic action", async () => {
    const copied: string[] = [];
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const component = dashboardComponent(client, async (text) => {
      copied.push(text);
    });
    await Bun.sleep(0);

    component.handleInput("\r");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(copied).toEqual(["feat-Alpha"]);
    expect(component.snapshotState().message).toBe("Copied branch name: feat-Alpha");
    component.dispose();
  });

  test("renames a Topic through the actions prompt", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("Rename Topic");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("RENAME TOPIC");
    component.handleInput("2");
    component.handleInput("\r");
    await Bun.sleep(0);
    expect(client.renameCalls).toEqual([
      { topicId: ID_A, name: "Alpha2", requestId: expect.any(String) },
    ]);
    component.dispose();
  });

  test("creates a child Topic from the Parent Topic side view", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const resolved: ResolvedChildTopicCreationInput = {
      parentTopicId: ID_A,
      name: "Templates",
      branch: "templates",
      startPoint: { commit: "a".repeat(40), sourceCheckout: "/work/Alpha" },
    };
    const resolveCalls: unknown[] = [];
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 40 }, requestRender: () => undefined } as never,
      connect: async () => client,
      done: () => undefined,
      resolveChildInput: async (input) => {
        resolveCalls.push(input);
        return resolved;
      },
    });
    await Bun.sleep(0);
    component.handleInput("\r");
    // Actions: copy, workspace, terminal, agent, reset-agent, rename, note, add-child.
    for (let step = 0; step < 7; step += 1) component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("ADD CHILD TOPIC");

    component.handleInput("Templates");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("Start Point");
    component.handleInput("HEAD~1");
    component.handleInput("\r");
    component.handleInput("\r");
    const review = component.render(80).join("\n");
    expect(review).toContain("Start Point: HEAD~1");
    expect(review).toContain("Branch: templates");
    component.handleInput("\r");
    await Bun.sleep(0);

    expect(resolveCalls).toEqual([
      {
        parentTopicId: ID_A,
        name: "Templates",
        startPoint: "HEAD~1",
        sourceCheckout: "/work/Alpha",
        branch: "templates",
      },
    ]);
    expect(client.createChildCalls).toEqual([{ input: resolved, requestId: expect.any(String) }]);
    component.dispose();
  });

  test("cancels a rename with Escape and makes no request", async () => {
    const client = new FakeDashboardClient([topic(ID_A, "Alpha")]);
    const component = dashboardComponent(client);
    await Bun.sleep(0);
    component.handleInput("\r");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("j");
    component.handleInput("\r");
    expect(component.render(80).join("\n")).toContain("RENAME TOPIC");
    component.handleInput("\x1b");
    await Bun.sleep(0);
    expect(client.renameCalls).toHaveLength(0);
    expect(component.render(80).join("\n")).not.toContain("RENAME TOPIC");
    component.dispose();
  });
});

describe("dashboard subscription lifecycle", () => {
  test("runs the single shimmer timer for delegated thinking and stops after settle", async () => {
    const client = new FakeDashboardClient();
    let shimmerTick: (() => void) | undefined;
    let activeTimers = 0;
    const component = new WorkDashboardComponent({
      tui: { terminal: { rows: 20 }, requestRender: () => undefined } as never,
      connect: async () => client,
      done: () => undefined,
      setInterval: ((handler: () => void) => {
        shimmerTick = handler;
        activeTimers += 1;
        return 1;
      }) as unknown as typeof setInterval,
      clearInterval: (() => {
        activeTimers -= 1;
      }) as typeof clearInterval,
    });
    await Bun.sleep(0);

    client.handler?.({
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "thinking-sub", connected: true },
    });
    expect(activeTimers).toBe(1);
    const startedAt = component.snapshotState().shimmerPhase;
    shimmerTick?.();
    expect(component.snapshotState().shimmerPhase).toBe(startedAt + 1);

    client.handler?.({
      type: "main-agent-changed",
      agent: { topicId: ID_A, sessionId: ID_A, state: "idle", connected: true },
    });
    expect(activeTimers).toBe(0);
    component.dispose();
  });

  test("closes the subscription after Escape and session-style disposal", async () => {
    const first = new FakeDashboardClient();
    let done = 0;
    const tui = { terminal: { rows: 20 }, requestRender: () => undefined };
    const component = new WorkDashboardComponent({
      tui: tui as never,
      connect: async () => first,
      done: () => {
        done += 1;
      },
    });
    await Bun.sleep(0);
    component.handleInput("\x1b");
    expect(done).toBe(1);
    expect(first.closed).toBe(1);

    const second = new FakeDashboardClient();
    const shutdownComponent = new WorkDashboardComponent({
      tui: tui as never,
      connect: async () => second,
      done: () => undefined,
    });
    await Bun.sleep(0);
    shutdownComponent.dispose();
    shutdownComponent.dispose();
    expect(second.closed).toBe(1);
  });
});

function dashboardComponent(
  client: FakeDashboardClient,
  copyToClipboard?: (text: string) => Promise<void>,
): WorkDashboardComponent {
  return new WorkDashboardComponent({
    tui: { terminal: { rows: 24 }, requestRender: () => undefined } as never,
    connect: async () => client,
    done: () => undefined,
    ...(copyToClipboard === undefined ? {} : { copyToClipboard }),
  });
}

function enterWizard(
  component: WorkDashboardComponent,
  name: string,
  branch: string,
  repository: string,
): void {
  component.handleInput("a");
  component.handleInput(name);
  component.handleInput("\r");
  component.handleInput(repository);
  component.handleInput("\r");
  const generated = defaultBranchForTopicName(name);
  for (let index = 0; index < generated.length; index += 1) component.handleInput("\x7f");
  component.handleInput(branch);
  component.handleInput("\r");
  component.handleInput("\r");
}
