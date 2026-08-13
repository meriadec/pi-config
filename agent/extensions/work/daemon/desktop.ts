import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { WorkDataError, boundMessage } from "../shared/domain.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./process-runner.ts";

const FIRST_WORKSPACE = 1;
const LAST_WORKSPACE = 10;
const PROCESS_TIMEOUT_MS = 2_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_RECONCILE_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 50;

interface I3Node {
  id?: number;
  type?: string;
  num?: number;
  name?: string;
  window?: number | null;
  marks?: unknown;
  window_properties?: { class?: unknown; instance?: unknown };
  nodes?: unknown;
  floating_nodes?: unknown;
}

interface WindowLocation {
  conId: number;
  workspace: number;
}

export type WorkspaceActionResult =
  | { kind: "focused"; workspace: number; message: string }
  | { kind: "unavailable"; message: string };

export type TerminalActionResult =
  | { kind: "launched"; workspace: number; message: string }
  | { kind: "unavailable"; message: string };

export type MainAgentActionResult =
  | { kind: "focused" | "launched"; workspace: number; message: string }
  | { kind: "unavailable"; message: string };

export type CloseMainAgentResult =
  | { kind: "closed" | "absent"; message: string }
  | { kind: "unavailable"; message: string };

export type PullRequestActionResult =
  | { kind: "opened"; message: string }
  | { kind: "unavailable"; message: string };

export interface MainAgentLaunch {
  topicId: string;
  topicName: string;
  worktreePath: string;
  sessionId: string;
  socketPath: string;
  registrationToken: string;
  affiliationToken: string;
}

export interface DesktopController {
  accessWorkspace(topicId: string): Promise<WorkspaceActionResult>;
  openTerminal(topicId: string, worktreePath: string): Promise<TerminalActionResult>;
  openMainAgent?(launch: MainAgentLaunch): Promise<MainAgentActionResult>;
  closeMainAgent?(topicId: string): Promise<CloseMainAgentResult>;
  openPullRequest?(url: string): Promise<PullRequestActionResult>;
}

export interface DesktopControllerOptions {
  runner: ProcessRunner;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  reconcileTimeoutMs?: number;
  pollIntervalMs?: number;
  i3Command?: string;
  kittyCommand?: string;
  nodeCommand?: string;
  piCommand?: string;
  shellCommand?: string;
  browserCommand?: string;
  processCwd?: string;
  runtimeDir?: string;
  writeRcFile?: (path: string, content: string) => Promise<void>;
}

/** Owns all i3 workspace lookup and marked kitty window reconciliation. */
export class I3KittyDesktopController implements DesktopController {
  private readonly runner: ProcessRunner;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly reconcileTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly i3Command: string;
  private readonly kittyCommand: string;
  private readonly nodeCommand: string | undefined;
  private readonly piCommand: string;
  private readonly shellCommand: string;
  private readonly browserCommand: string;
  private readonly processCwd: string;
  private readonly runtimeDir: string;
  private readonly writeRcFile: (path: string, content: string) => Promise<void>;

  constructor(options: DesktopControllerOptions) {
    this.runner = options.runner;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
    this.reconcileTimeoutMs = options.reconcileTimeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.i3Command = options.i3Command ?? "i3-msg";
    this.kittyCommand = options.kittyCommand ?? "kitty";
    this.nodeCommand = options.nodeCommand;
    this.piCommand = options.piCommand ?? "pi";
    this.shellCommand = options.shellCommand ?? defaultLoginShell();
    this.browserCommand = options.browserCommand ?? "xdg-open";
    this.processCwd = options.processCwd ?? process.cwd();
    this.runtimeDir = options.runtimeDir ?? process.env["XDG_RUNTIME_DIR"] ?? tmpdir();
    this.writeRcFile = options.writeRcFile ?? defaultWriteRcFile;
  }

  async accessWorkspace(topicId: string): Promise<WorkspaceActionResult> {
    const selection = selectTopicWorkspace(await this.getTree(), topicId);
    if (selection.kind === "unavailable") return selection;
    await this.focusWorkspace(selection.workspace);
    return {
      kind: "focused",
      workspace: selection.workspace,
      message: `Focused Topic workspace ${selection.workspace}.`,
    };
  }

  async openTerminal(topicId: string, worktreePath: string): Promise<TerminalActionResult> {
    const mark = topicMark(topicId);
    const identity = topicWindowIdentity(topicId);
    const beforeTree = await this.getTree();
    const selection = selectTopicWorkspace(beforeTree, topicId);
    if (selection.kind === "unavailable") return selection;
    const existingIdentityIds = new Set(
      findIdentityWindows(beforeTree, identity).map((item) => item.conId),
    );

    await this.focusWorkspace(selection.workspace);
    const launch = await this.run({
      command: this.kittyCommand,
      args: [
        "--single-instance",
        "--instance-group",
        "i3",
        "--detach",
        "--class",
        identity,
        "--name",
        identity,
        "--directory",
        worktreePath,
      ],
      cwd: worktreePath,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    requireCompleted(launch, "Kitty launch");

    const match = await this.reconcileIdentity(identity, existingIdentityIds);
    if (match.kind === "unavailable") return match;
    await this.i3CommandRun(
      `[con_id=${match.conId}] move container to workspace number ${selection.workspace}, mark --add ${mark}`,
      "i3 window reconciliation",
    );
    return {
      kind: "launched",
      workspace: selection.workspace,
      message: `Opened Topic terminal on workspace ${selection.workspace}.`,
    };
  }

  async closeMainAgent(topicId: string): Promise<CloseMainAgentResult> {
    const existing = findMarkedWindows(await this.getTree(), mainAgentMark(topicId));
    if (existing.length === 0) {
      return { kind: "absent", message: "No Main Agent window is open." };
    }
    if (existing.length > 1) {
      return {
        kind: "unavailable",
        message: "Multiple Main Agent windows exist; no window was changed.",
      };
    }
    await this.i3CommandRun(`[con_id=${existing[0]!.conId}] kill`, "Main Agent close");
    return { kind: "closed", message: "Closed the previous Main Agent window." };
  }

  async openPullRequest(url: string): Promise<PullRequestActionResult> {
    const launch = await this.run({
      command: this.browserCommand,
      args: [url],
      cwd: this.processCwd,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    if (launch.status !== "completed" || launch.exitCode !== 0) {
      return { kind: "unavailable", message: "Could not open the pull request in a browser." };
    }
    return { kind: "opened", message: "Opened the pull request in a browser." };
  }

  async openMainAgent(launch: MainAgentLaunch): Promise<MainAgentActionResult> {
    const tree = await this.getTree();
    const mainMark = mainAgentMark(launch.topicId);
    const existing = findMarkedWindows(tree, mainMark);
    if (existing.length === 1) {
      await this.i3CommandRun(`[con_id=${existing[0]!.conId}] focus`, "Main Agent focus");
      return {
        kind: "focused",
        workspace: existing[0]!.workspace,
        message: `Focused Main Agent on workspace ${existing[0]!.workspace}.`,
      };
    }
    if (existing.length > 1) {
      return {
        kind: "unavailable",
        message: "Multiple Main Agent windows exist; no window was changed.",
      };
    }

    const selection = selectTopicWorkspace(tree, launch.topicId);
    if (selection.kind === "unavailable") return selection;
    const identity = mainAgentWindowIdentity(launch.topicId);
    const existingIdentityIds = new Set(
      findIdentityWindows(tree, identity).map((item) => item.conId),
    );
    await this.focusWorkspace(selection.workspace);
    // Run Pi through the user's interactive login shell so shell aliases load
    // and Pi becomes a suspendable job-control child. zsh and bash start Pi
    // from a startup file so `Ctrl-Z` drops to an interactive prompt (and `fg`
    // resumes Pi) instead of closing the window.
    const invocation = mainAgentShellInvocation({
      shellPath: this.shellCommand,
      runtimeDir: this.runtimeDir,
      topicId: launch.topicId,
      nodeCommand: this.nodeCommand,
      piCommand: this.piCommand,
      sessionId: launch.sessionId,
      topicName: launch.topicName,
    });
    if (invocation.rcFile !== undefined) {
      await this.writeRcFile(invocation.rcFile.path, invocation.rcFile.content);
    }
    const result = await this.run({
      command: this.kittyCommand,
      args: [
        "--single-instance",
        "--instance-group",
        "i3",
        "--detach",
        "--class",
        identity,
        "--name",
        identity,
        "--directory",
        launch.worktreePath,
        ...invocation.args,
      ],
      cwd: launch.worktreePath,
      env: {
        ...invocation.env,
        PI_WORK_TOPIC_ID: launch.topicId,
        PI_WORK_SOCKET: launch.socketPath,
        PI_WORK_REGISTRATION_TOKEN: launch.registrationToken,
        PI_WORK_SESSION_ID: launch.sessionId,
        // Durable, non-secret window affiliation. It stays in the window process
        // environment so a later in-window /new session can adopt this Topic. It
        // never enters the shell command line, manifests, or logs.
        PI_WORK_AFFILIATION: launch.affiliationToken,
        // Launch-time Topic name so an adopted in-window /new session can restore
        // the "Work: <topic>" footer label that --name gives the first session.
        PI_WORK_TOPIC_NAME: launch.topicName,
      },
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    requireCompleted(result, "Main Agent launch");
    const match = await this.reconcileIdentity(identity, existingIdentityIds);
    if (match.kind === "unavailable") return match;
    await this.i3CommandRun(
      `[con_id=${match.conId}] move container to workspace number ${selection.workspace}, mark --add ${topicMark(launch.topicId)}, mark --add ${mainMark}`,
      "Main Agent reconciliation",
    );
    return {
      kind: "launched",
      workspace: selection.workspace,
      message: `Opened Main Agent on workspace ${selection.workspace}.`,
    };
  }

  private async reconcileIdentity(
    identity: string,
    existingIds: ReadonlySet<number>,
  ): Promise<{ kind: "matched"; conId: number } | { kind: "unavailable"; message: string }> {
    const deadline = this.now() + this.reconcileTimeoutMs;
    let poll = true;
    while (poll) {
      const matches = findIdentityWindows(await this.getTree(), identity).filter(
        (item) => !existingIds.has(item.conId),
      );
      if (matches.length === 1) return { kind: "matched", conId: matches[0]!.conId };
      if (matches.length > 1) {
        return {
          kind: "unavailable",
          message: "The new Kitty window identity is ambiguous; no window was changed.",
        };
      }
      poll = this.now() < deadline;
      if (poll) await this.sleep(this.pollIntervalMs);
    }
    return {
      kind: "unavailable",
      message: "Timed out while finding the new Kitty window; no window was changed.",
    };
  }

  private async getTree(): Promise<I3Node> {
    const result = await this.run({
      command: this.i3Command,
      args: ["-t", "get_tree"],
      cwd: this.processCwd,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    requireCompleted(result, "i3 tree query");
    if (result.outputTruncated) {
      throw new WorkDataError(
        "desktop-output-too-large",
        "i3 tree output exceeded the safe limit.",
      );
    }
    try {
      const tree: unknown = JSON.parse(result.stdout);
      if (!isNode(tree)) throw new Error("not a node");
      return tree;
    } catch {
      throw new WorkDataError("invalid-i3-tree", "i3 returned an invalid tree.");
    }
  }

  private async focusWorkspace(workspace: number): Promise<void> {
    await this.i3CommandRun(`workspace number ${workspace}`, "i3 workspace focus");
  }

  private async i3CommandRun(command: string, label: string): Promise<void> {
    const result = await this.run({
      command: this.i3Command,
      args: [command],
      cwd: this.processCwd,
      timeoutMs: PROCESS_TIMEOUT_MS,
      maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
    });
    requireCompleted(result, label);
  }

  private async run(request: ProcessRequest): Promise<ProcessResult> {
    try {
      return await this.runner.run(request);
    } catch {
      throw new WorkDataError("desktop-process-failed", "Desktop process could not start.");
    }
  }
}

function defaultLoginShell(): string {
  try {
    const shell = userInfo().shell;
    if (typeof shell === "string" && shell.length > 0) return shell;
  } catch {
    // Fall through to the POSIX default below.
  }
  return "/bin/sh";
}

/**
 * How to launch Pi as a suspendable Main Agent job.
 *
 * `args` are the shell command and arguments Kitty runs. `env` are extra
 * environment variables the shell needs (for example `ZDOTDIR`). When present,
 * `rcFile` must be written before the shell starts.
 */
export interface MainAgentShellInvocation {
  args: string[];
  env: Record<string, string>;
  rcFile?: { path: string; content: string };
}

/**
 * Build the shell invocation that runs Pi so `Ctrl-Z` suspends Pi to an
 * interactive shell prompt (and `fg` resumes it) without closing the window.
 *
 * A plain `shell -i -c "pi"` shell exhausts its `-c` command source the moment
 * Pi stops, so the shell exits, its window closes, and the stopped Pi job dies.
 * To keep an interactive prompt whose job table holds the stopped Pi, the shell
 * must read commands from the terminal, not from `-c`. Thus zsh and bash start
 * Pi from a startup file and stay interactive. Other shells keep the legacy
 * `-c` behavior, which does not preserve job control.
 */
export function mainAgentShellInvocation(options: {
  shellPath: string;
  runtimeDir: string;
  topicId: string;
  nodeCommand: string | undefined;
  piCommand: string;
  sessionId: string;
  topicName: string;
}): MainAgentShellInvocation {
  const piArgv = [
    ...(options.nodeCommand === undefined
      ? [options.piCommand]
      : [options.nodeCommand, options.piCommand]),
    "--session-id",
    options.sessionId,
    "--name",
    `Work: ${options.topicName}`,
  ];
  const piLine = piArgv.map(shellQuote).join(" ");
  const shellName = basename(options.shellPath);
  const rcDir = join(options.runtimeDir, "pi-work-shell", digest(options.topicId));

  if (shellName === "zsh") {
    const path = join(rcDir, ".zshrc");
    // ZDOTDIR redirects zsh startup here; source the user's own .zshrc first so
    // aliases still load, then run Pi as a foreground job. No command follows
    // Pi, so a suspend drops straight to this interactive prompt.
    const content = `[ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n${piLine}\n`;
    return { args: [options.shellPath, "-i"], env: { ZDOTDIR: rcDir }, rcFile: { path, content } };
  }

  if (shellName === "bash") {
    const path = join(rcDir, "rc");
    const content = `[ -r "$HOME/.bashrc" ] && source "$HOME/.bashrc"\n${piLine}\n`;
    return {
      args: [options.shellPath, "--rcfile", path, "-i"],
      env: {},
      rcFile: { path, content },
    };
  }

  // Unknown shell: keep the previous behavior. Job control is not preserved.
  return { args: [options.shellPath, "-i", "-c", `${piLine}\n:`], env: {} };
}

/** Write a shell startup file with private permissions. */
async function defaultWriteRcFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function topicMark(topicId: string): string {
  return `pi-work-topic-${digest(topicId)}`;
}

export function topicWindowIdentity(topicId: string): string {
  return `pi-work-kitty-${digest(topicId)}`;
}

export function mainAgentMark(topicId: string): string {
  return `pi-work-agent-${digest(topicId)}`;
}

export function mainAgentWindowIdentity(topicId: string): string {
  return `pi-work-main-agent-${digest(topicId)}`;
}

/**
 * Find the pool workspace that holds this Topic's windows, or lease an empty
 * one. i3 marks are unique per window, so `topicMark` can only ever sit on one
 * window at a time and it hops to the newest terminal; it vanishes when that
 * single window closes. To stay robust, a window counts as a Topic window when
 * it carries any Topic mark (terminal or Main Agent) or its durable kitty
 * window identity matches the Topic. Thus the Main Agent window alone keeps the
 * Topic anchored to its workspace after transient terminals close.
 */
export function selectTopicWorkspace(
  tree: unknown,
  topicId: string,
): { kind: "selected"; workspace: number } | { kind: "unavailable"; message: string } {
  if (!isNode(tree)) throw new WorkDataError("invalid-i3-tree", "i3 returned an invalid tree.");
  const mainMark = mainAgentMark(topicId);
  const marks = new Set([topicMark(topicId), mainMark]);
  const identities = new Set([topicWindowIdentity(topicId), mainAgentWindowIdentity(topicId)]);
  const topicWorkspaces = new Set<number>();
  let mainAgentWorkspace: number | undefined;
  const materialized = new Map<number, I3Node>();
  walk(tree, undefined, (node, workspace) => {
    if (node.type === "workspace" && isPoolWorkspace(node.num)) materialized.set(node.num, node);
    if (workspace === undefined) return;
    if (isTopicWindow(node, marks, identities)) topicWorkspaces.add(workspace);
    if (nodeMarks(node).includes(mainMark)) mainAgentWorkspace = workspace;
  });
  // The Main Agent window is the Topic's durable anchor. Its mark is globally
  // unique in i3, so when it exists its workspace is authoritative even if a
  // leftover terminal lingers on another workspace. Without this, a split
  // layout would look ambiguous and refuse to move.
  if (mainAgentWorkspace !== undefined) {
    return { kind: "selected", workspace: mainAgentWorkspace };
  }
  if (topicWorkspaces.size === 1) {
    return { kind: "selected", workspace: [...topicWorkspaces][0]! };
  }
  if (topicWorkspaces.size > 1) {
    return {
      kind: "unavailable",
      message: "Topic windows are on multiple workspaces; no workspace was changed.",
    };
  }
  for (let workspace = FIRST_WORKSPACE; workspace <= LAST_WORKSPACE; workspace += 1) {
    const node = materialized.get(workspace);
    if (node === undefined || !containsWindow(node)) return { kind: "selected", workspace };
  }
  return {
    kind: "unavailable",
    message: "No empty workspace is available in the temporary pool (1-10).",
  };
}

function isTopicWindow(
  node: I3Node,
  marks: ReadonlySet<string>,
  identities: ReadonlySet<string>,
): boolean {
  if (nodeMarks(node).some((mark) => marks.has(mark))) return true;
  const identity = node.window_properties?.class;
  return typeof identity === "string" && identities.has(identity);
}

function findMarkedWindows(tree: I3Node, mark: string): WindowLocation[] {
  const matches: WindowLocation[] = [];
  walk(tree, undefined, (node, workspace) => {
    if (workspace !== undefined && typeof node.id === "number" && nodeMarks(node).includes(mark)) {
      matches.push({ conId: node.id, workspace });
    }
  });
  return matches;
}

function findIdentityWindows(tree: I3Node, identity: string): WindowLocation[] {
  const matches: WindowLocation[] = [];
  walk(tree, undefined, (node, workspace) => {
    const properties = node.window_properties;
    if (
      workspace !== undefined &&
      typeof node.id === "number" &&
      properties?.class === identity &&
      properties.instance === identity
    ) {
      matches.push({ conId: node.id, workspace });
    }
  });
  return matches;
}

function walk(
  node: I3Node,
  workspace: number | undefined,
  visit: (node: I3Node, workspace: number | undefined) => void,
): void {
  const currentWorkspace =
    node.type === "workspace" && typeof node.num === "number" ? node.num : workspace;
  visit(node, currentWorkspace);
  for (const child of children(node)) walk(child, currentWorkspace, visit);
}

function children(node: I3Node): I3Node[] {
  const values = [...array(node.nodes), ...array(node.floating_nodes)];
  return values.filter(isNode);
}

function containsWindow(node: I3Node): boolean {
  if (typeof node.window === "number") return true;
  return children(node).some(containsWindow);
}

function nodeMarks(node: I3Node): string[] {
  return Array.isArray(node.marks)
    ? node.marks.filter((value): value is string => typeof value === "string")
    : [];
}

function isNode(value: unknown): value is I3Node {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isPoolWorkspace(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= FIRST_WORKSPACE &&
    value <= LAST_WORKSPACE
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function requireCompleted(result: ProcessResult, label: string): void {
  if (result.status === "timeout") {
    throw new WorkDataError("desktop-timeout", `${label} timed out.`);
  }
  if (result.status === "cancelled") {
    throw new WorkDataError("desktop-cancelled", `${label} was cancelled.`);
  }
  if (result.exitCode !== 0) {
    throw new WorkDataError("desktop-process-failed", boundMessage(`${label} failed.`));
  }
}
