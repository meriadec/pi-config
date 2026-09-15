import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  type AbsolutePath,
  DesktopFailure,
  type PrivateLocalCapability,
  type TopicId,
} from "../../domain/index.ts";
import { ProcessExecutor, type ProcessResult } from "../process/index.ts";

const FIRST_WORKSPACE = 1;
const LAST_WORKSPACE = 10;
const PROCESS_TIMEOUT_MS = 2_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1_024;
const RECONCILE_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 50;

export interface I3Node {
  readonly id?: number | undefined;
  readonly type?: string | undefined;
  readonly num?: number | undefined;
  readonly window?: number | null | undefined;
  readonly marks?: readonly string[] | undefined;
  readonly window_properties?:
    | { readonly class?: string | undefined; readonly instance?: string | undefined }
    | undefined;
  readonly nodes?: readonly I3Node[] | undefined;
  readonly floating_nodes?: readonly I3Node[] | undefined;
}

const RawI3Node = Schema.Struct({
  id: Schema.optional(Schema.Number),
  type: Schema.optional(Schema.String),
  num: Schema.optional(Schema.Number),
  window: Schema.optional(Schema.NullOr(Schema.Number)),
  marks: Schema.optional(Schema.Array(Schema.String)),
  window_properties: Schema.optional(
    Schema.Struct({
      class: Schema.optional(Schema.String),
      instance: Schema.optional(Schema.String),
    }),
  ),
  nodes: Schema.optional(Schema.Array(Schema.Unknown)),
  floating_nodes: Schema.optional(Schema.Array(Schema.Unknown)),
});

export type WorkspaceActionResult =
  | { readonly kind: "focused"; readonly workspace: number; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type TerminalActionResult =
  | { readonly kind: "launched"; readonly workspace: number; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type MainAgentActionResult =
  | { readonly kind: "focused" | "launched"; readonly workspace: number; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type CloseMainAgentResult =
  | { readonly kind: "closed" | "absent"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type BrowserActionResult =
  | { readonly kind: "opened"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

export interface MainAgentLaunch {
  readonly topicId: TopicId;
  readonly topicName: string;
  readonly worktreePath: AbsolutePath;
  readonly sessionId: string;
  readonly socketPath: AbsolutePath;
  readonly registrationToken: PrivateLocalCapability;
  readonly affiliationToken: PrivateLocalCapability;
}

type DesktopRequirements = ChildProcessSpawner.ChildProcessSpawner | Scope.Scope;
type DesktopEffect<A> = Effect.Effect<A, DesktopFailure, DesktopRequirements>;

/** Semantic i3, Kitty, Main Agent, and browser actions. */
export interface DesktopControl {
  readonly accessWorkspace: (topicId: TopicId) => DesktopEffect<WorkspaceActionResult>;
  /** Observes the current or next available Topic workspace without changing focus. */
  readonly topicWorkspace: (topicId: TopicId) => DesktopEffect<number | undefined>;
  readonly openTerminal: (
    topicId: TopicId,
    worktreePath: AbsolutePath,
  ) => DesktopEffect<TerminalActionResult>;
  readonly openMainAgent: (launch: MainAgentLaunch) => DesktopEffect<MainAgentActionResult>;
  readonly closeMainAgent: (topicId: TopicId) => DesktopEffect<CloseMainAgentResult>;
  readonly openBrowser: (url: string) => DesktopEffect<BrowserActionResult>;
}

export const DesktopControl = Context.Service<DesktopControl>("Work/DesktopControl");

export interface DesktopControlOptions {
  readonly i3Executable?: string;
  readonly kittyExecutable?: string;
  readonly browserExecutable?: string;
  readonly nodeExecutable?: string;
  readonly piExecutable?: string;
  readonly shellExecutable?: string;
  readonly processCwd: AbsolutePath;
  readonly runtimeDirectory: AbsolutePath;
  readonly reconcileTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export function makeDesktopControl(
  processes: ProcessExecutor,
  fs: FileSystem.FileSystem,
  options: DesktopControlOptions,
): DesktopControl {
  const i3 = options.i3Executable ?? "i3-msg";
  const kitty = options.kittyExecutable ?? "kitty";
  const run = (
    executable: string,
    arguments_: readonly string[],
    cwd: AbsolutePath,
    environment?: Readonly<Record<string, string>>,
  ) =>
    processes
      .run({
        command: { _tag: "Executable", executable, arguments: arguments_ },
        cwd,
        timeoutMs: PROCESS_TIMEOUT_MS,
        maxOutputBytes: MAX_PROCESS_OUTPUT_BYTES,
        ...(environment === undefined ? {} : { environment }),
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("unavailable", "A desktop process could not start.", cause),
        ),
      );
  const completed = (label: string) => (result: ProcessResult) => {
    if (result.status !== "completed" || result.exitCode !== 0 || result.outputTruncated) {
      return Effect.fail(failure("unavailable", `${label} failed.`, result));
    }
    return Effect.succeed(result);
  };
  const i3Command = (command: string, label: string) =>
    run(i3, [command], options.processCwd).pipe(Effect.flatMap(completed(label)), Effect.asVoid);
  const getTree = Effect.suspend(() =>
    run(i3, ["-t", "get_tree"], options.processCwd).pipe(
      Effect.flatMap(completed("The i3 tree query")),
      Effect.flatMap((result) =>
        Effect.try({
          try: () => JSON.parse(result.stdout) as unknown,
          catch: (cause) => failure("invalid-response", "i3 returned invalid JSON.", cause),
        }),
      ),
      Effect.flatMap((value) =>
        Effect.try({
          try: () => decodeI3Node(value),
          catch: (cause) => failure("invalid-response", "i3 returned an invalid tree.", cause),
        }),
      ),
    ),
  );
  const focusWorkspace = (workspace: number) =>
    i3Command(`workspace number ${workspace}`, "The i3 workspace focus");

  const reconcileIdentity = (identity: string, existingIds: ReadonlySet<number>) =>
    Effect.gen(function* () {
      const start = yield* Clock.currentTimeMillis;
      const deadline = start + (options.reconcileTimeoutMs ?? RECONCILE_TIMEOUT_MS);
      while (true) {
        const matches = findIdentityWindows(yield* getTree, identity).filter(
          (item) => !existingIds.has(item.conId),
        );
        if (matches.length === 1) return { kind: "matched" as const, conId: matches[0]!.conId };
        if (matches.length > 1) {
          return {
            kind: "unavailable" as const,
            message: "The new Kitty window identity is ambiguous; no window was changed.",
          };
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) {
          return {
            kind: "unavailable" as const,
            message: "Timed out while finding the new Kitty window; no window was changed.",
          };
        }
        yield* Effect.sleep(options.pollIntervalMs ?? POLL_INTERVAL_MS);
      }
    });

  return {
    topicWorkspace: (topicId) =>
      getTree.pipe(
        Effect.map((tree) => selectTopicWorkspace(tree, topicId)),
        Effect.map((selection) =>
          selection.kind === "selected" ? selection.workspace : undefined,
        ),
      ),
    accessWorkspace: (topicId) =>
      Effect.gen(function* () {
        const selection = selectTopicWorkspace(yield* getTree, topicId);
        if (selection.kind === "unavailable") return selection;
        yield* focusWorkspace(selection.workspace);
        return {
          kind: "focused" as const,
          workspace: selection.workspace,
          message: `Focused Topic workspace ${selection.workspace}.`,
        };
      }),
    openTerminal: (topicId, worktreePath) =>
      Effect.gen(function* () {
        const identity = topicWindowIdentity(topicId);
        const tree = yield* getTree;
        const selection = selectTopicWorkspace(tree, topicId);
        if (selection.kind === "unavailable") return selection;
        const existing = new Set(findIdentityWindows(tree, identity).map((item) => item.conId));
        yield* focusWorkspace(selection.workspace);
        yield* run(
          kitty,
          [
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
          worktreePath,
        ).pipe(Effect.flatMap(completed("The Kitty launch")));
        const match = yield* reconcileIdentity(identity, existing);
        if (match.kind === "unavailable") return match;
        yield* i3Command(
          `[con_id=${match.conId}] move container to workspace number ${selection.workspace}, mark --add ${topicMark(topicId)}`,
          "The i3 window reconciliation",
        );
        return {
          kind: "launched" as const,
          workspace: selection.workspace,
          message: `Opened Topic terminal on workspace ${selection.workspace}.`,
        };
      }),
    closeMainAgent: (topicId) =>
      Effect.gen(function* () {
        const existing = findMarkedWindows(yield* getTree, mainAgentMark(topicId));
        if (existing.length === 0)
          return { kind: "absent" as const, message: "No Main Agent window is open." };
        if (existing.length > 1)
          return {
            kind: "unavailable" as const,
            message: "Multiple Main Agent windows exist; no window was changed.",
          };
        yield* i3Command(`[con_id=${existing[0]!.conId}] kill`, "The Main Agent close");
        return { kind: "closed" as const, message: "Closed the previous Main Agent window." };
      }),
    openBrowser: (url) =>
      run(options.browserExecutable ?? "xdg-open", [url], options.processCwd).pipe(
        Effect.map((result) =>
          result.status === "completed" && result.exitCode === 0
            ? { kind: "opened" as const, message: "Opened the pull request in a browser." }
            : {
                kind: "unavailable" as const,
                message: "Could not open the pull request in a browser.",
              },
        ),
        Effect.catchTag("DesktopFailure", () =>
          Effect.succeed({
            kind: "unavailable" as const,
            message: "Could not open the pull request in a browser.",
          }),
        ),
      ),
    openMainAgent: (launch) =>
      Effect.gen(function* () {
        const tree = yield* getTree;
        const marked = findMarkedWindows(tree, mainAgentMark(launch.topicId));
        if (marked.length === 1) {
          yield* i3Command(`[con_id=${marked[0]!.conId}] focus`, "The Main Agent focus");
          return {
            kind: "focused" as const,
            workspace: marked[0]!.workspace,
            message: `Focused Main Agent on workspace ${marked[0]!.workspace}.`,
          };
        }
        if (marked.length > 1)
          return {
            kind: "unavailable" as const,
            message: "Multiple Main Agent windows exist; no window was changed.",
          };
        const selection = selectTopicWorkspace(tree, launch.topicId);
        if (selection.kind === "unavailable") return selection;
        const identity = mainAgentWindowIdentity(launch.topicId);
        const existing = new Set(findIdentityWindows(tree, identity).map((item) => item.conId));
        yield* focusWorkspace(selection.workspace);
        const invocation = mainAgentShellInvocation({
          shellPath: options.shellExecutable ?? process.env["SHELL"] ?? "/bin/sh",
          runtimeDir: options.runtimeDirectory,
          topicId: launch.topicId,
          nodeCommand: options.nodeExecutable,
          piCommand: options.piExecutable ?? "pi",
          sessionId: launch.sessionId,
          topicName: launch.topicName,
        });
        if (invocation.rcFile !== undefined)
          yield* writePrivateStartupFile(fs, invocation.rcFile.path, invocation.rcFile.content);
        yield* run(
          kitty,
          [
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
          launch.worktreePath,
          {
            ...invocation.environment,
            PI_WORK_TOPIC_ID: launch.topicId,
            PI_WORK_SOCKET: launch.socketPath,
            PI_WORK_REGISTRATION_TOKEN: Redacted.value(launch.registrationToken),
            PI_WORK_SESSION_ID: launch.sessionId,
            PI_WORK_AFFILIATION: Redacted.value(launch.affiliationToken),
            PI_WORK_TOPIC_NAME: launch.topicName,
          },
        ).pipe(Effect.flatMap(completed("The Main Agent launch")));
        const match = yield* reconcileIdentity(identity, existing);
        if (match.kind === "unavailable") return match;
        yield* i3Command(
          `[con_id=${match.conId}] move container to workspace number ${selection.workspace}, mark --add ${topicMark(launch.topicId)}, mark --add ${mainAgentMark(launch.topicId)}`,
          "The Main Agent reconciliation",
        );
        return {
          kind: "launched" as const,
          workspace: selection.workspace,
          message: `Opened Main Agent on workspace ${selection.workspace}.`,
        };
      }),
  };
}

export const DesktopControlLive = (options: DesktopControlOptions) =>
  Layer.effect(
    DesktopControl,
    Effect.gen(function* () {
      return makeDesktopControl(yield* ProcessExecutor, yield* FileSystem.FileSystem, options);
    }),
  );

export interface MainAgentShellInvocation {
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly rcFile?: { readonly path: string; readonly content: string };
}

export function mainAgentShellInvocation(options: {
  readonly shellPath: string;
  readonly runtimeDir: string;
  readonly topicId: string;
  readonly nodeCommand: string | undefined;
  readonly piCommand: string;
  readonly sessionId: string;
  readonly topicName: string;
}): MainAgentShellInvocation {
  const argv = [
    ...(options.nodeCommand === undefined
      ? [options.piCommand]
      : [options.nodeCommand, options.piCommand]),
    "--session-id",
    options.sessionId,
    "--name",
    `Work: ${options.topicName}`,
  ];
  const line = argv.map(shellQuote).join(" ");
  const directory = join(options.runtimeDir, "pi-work-shell", digest(options.topicId));
  if (basename(options.shellPath) === "zsh") {
    return {
      args: [options.shellPath, "-i"],
      environment: { ZDOTDIR: directory },
      rcFile: {
        path: join(directory, ".zshrc"),
        content: `[ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"\n${line}\n`,
      },
    };
  }
  if (basename(options.shellPath) === "bash") {
    const path = join(directory, "rc");
    return {
      args: [options.shellPath, "--rcfile", path, "-i"],
      environment: {},
      rcFile: { path, content: `[ -r "$HOME/.bashrc" ] && source "$HOME/.bashrc"\n${line}\n` },
    };
  }
  return { args: [options.shellPath, "-i", "-c", `${line}\n:`], environment: {} };
}

function writePrivateStartupFile(
  fs: FileSystem.FileSystem,
  path: string,
  content: string,
): Effect.Effect<void, DesktopFailure> {
  const directory = path.slice(0, path.lastIndexOf("/"));
  return fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
    Effect.andThen(fs.chmod(directory, 0o700)),
    Effect.andThen(fs.writeFileString(path, content, { flag: "w", mode: 0o600 })),
    Effect.andThen(fs.chmod(path, 0o600)),
    Effect.mapError((cause) =>
      failure("unavailable", "The private Main Agent startup file could not be written.", cause),
    ),
  );
}

export function selectTopicWorkspace(
  tree: I3Node,
  topicId: string,
):
  | { readonly kind: "selected"; readonly workspace: number }
  | { readonly kind: "unavailable"; readonly message: string } {
  const topicWorkspaces = new Set<number>();
  const materialized = new Map<number, I3Node>();
  let mainWorkspace: number | undefined;
  const marks = new Set([topicMark(topicId), mainAgentMark(topicId)]);
  const identities = new Set([topicWindowIdentity(topicId), mainAgentWindowIdentity(topicId)]);
  walk(tree, undefined, (node, workspace) => {
    if (node.type === "workspace" && isPoolWorkspace(node.num)) materialized.set(node.num, node);
    if (workspace === undefined) return;
    if (
      nodeMarks(node).some((mark) => marks.has(mark)) ||
      (node.window_properties?.class !== undefined && identities.has(node.window_properties.class))
    )
      topicWorkspaces.add(workspace);
    if (nodeMarks(node).includes(mainAgentMark(topicId))) mainWorkspace = workspace;
  });
  if (mainWorkspace !== undefined) return { kind: "selected", workspace: mainWorkspace };
  if (topicWorkspaces.size === 1) return { kind: "selected", workspace: [...topicWorkspaces][0]! };
  if (topicWorkspaces.size > 1)
    return {
      kind: "unavailable",
      message: "Topic windows are on multiple workspaces; no workspace was changed.",
    };
  for (let workspace = FIRST_WORKSPACE; workspace <= LAST_WORKSPACE; workspace += 1) {
    const node = materialized.get(workspace);
    if (node === undefined || !containsWindow(node)) return { kind: "selected", workspace };
  }
  return {
    kind: "unavailable",
    message: "No empty workspace is available in the temporary pool (1-10).",
  };
}

function decodeI3Node(value: unknown): I3Node {
  const node = Schema.decodeUnknownSync(RawI3Node, { errors: "first" })(value);
  return {
    ...node,
    nodes: node.nodes?.map(decodeI3Node),
    floating_nodes: node.floating_nodes?.map(decodeI3Node),
  };
}

export const topicMark = (topicId: string) => `pi-work-topic-${digest(topicId)}`;
export const topicWindowIdentity = (topicId: string) => `pi-work-kitty-${digest(topicId)}`;
export const mainAgentMark = (topicId: string) => `pi-work-agent-${digest(topicId)}`;
export const mainAgentWindowIdentity = (topicId: string) => `pi-work-main-agent-${digest(topicId)}`;

interface WindowLocation {
  readonly conId: number;
  readonly workspace: number;
}
function findMarkedWindows(tree: I3Node, mark: string): WindowLocation[] {
  const matches: WindowLocation[] = [];
  walk(tree, undefined, (node, workspace) => {
    if (workspace !== undefined && node.id !== undefined && nodeMarks(node).includes(mark))
      matches.push({ conId: node.id, workspace });
  });
  return matches;
}
function findIdentityWindows(tree: I3Node, identity: string): WindowLocation[] {
  const matches: WindowLocation[] = [];
  walk(tree, undefined, (node, workspace) => {
    if (
      workspace !== undefined &&
      node.id !== undefined &&
      node.window_properties?.class === identity &&
      node.window_properties.instance === identity
    )
      matches.push({ conId: node.id, workspace });
  });
  return matches;
}
function walk(
  node: I3Node,
  workspace: number | undefined,
  visit: (node: I3Node, workspace: number | undefined) => void,
): void {
  const current = node.type === "workspace" && node.num !== undefined ? node.num : workspace;
  visit(node, current);
  for (const child of [...(node.nodes ?? []), ...(node.floating_nodes ?? [])])
    walk(child, current, visit);
}
function containsWindow(node: I3Node): boolean {
  return (
    (node.window !== undefined && node.window !== null) ||
    [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(containsWindow)
  );
}
function nodeMarks(node: I3Node): readonly string[] {
  return node.marks ?? [];
}
function isPoolWorkspace(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    value >= FIRST_WORKSPACE &&
    value <= LAST_WORKSPACE
  );
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function failure(
  reason: "unavailable" | "invalid-response" | "ambiguous",
  message: string,
  internalCause: unknown,
): DesktopFailure {
  return new DesktopFailure({ reason, message, internalCause });
}
