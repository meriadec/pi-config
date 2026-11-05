#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { parseArgs, type FlagSpec } from "../src/args.ts";
import {
  REAL_ENVS,
  SBX_CLUSTER,
  kubeContext,
  resolveEnv,
  sanitizeInstanceName,
  type Env,
} from "../src/envs.ts";
import { KubeError, kubectl } from "../src/kube.ts";
import { buildLogsArgs, processLogs, validateTail } from "../src/logs.ts";
import {
  DEFAULT_SINCE,
  DEFAULT_TAIL,
  MAX_TABLE_LINES,
  MAX_TAIL,
  compileGrep,
  filterWorkloads,
  formatTable,
  grepLines,
  keepFirstLines,
  parseWorkloads,
  resolveWorkload,
  type Capped,
} from "../src/text.ts";

const USAGE = `vault-env: read-only view of Ledger Vault envs (never writes).

  envs [--verify]                         List aliases. --verify checks the clusters against \`tsh kube ls\`.
  pods <env> [--grep RE]                  Pods of an env.
  logs <env> <app> [--tail N] [--since D] [--grep RE]
                                          Logs of a workload, all pods and containers. Defaults: --tail ${DEFAULT_TAIL} --since ${DEFAULT_SINCE}, max --tail ${MAX_TAIL}.
  version <env> [app]                     Live image tag, ready replicas, ArgoCD app per workload.
  name <text>                             Valid vault-remote instance name from free text.

<env>: ${REAL_ENVS.map((e) => e.alias).join(" | ")} | sbx:<instance-name>`;

const FLAGS: Readonly<Record<string, FlagSpec>> = {
  envs: { verify: "boolean" },
  pods: { grep: "string" },
  logs: { tail: "string", since: "string", grep: "string" },
  version: {},
  name: {},
};

function print(capped: Capped): void {
  if (capped.text !== "") console.log(capped.text);
  if (capped.notice !== undefined) console.log(`[vault-env] ${capped.notice}`);
}

function requireEnv(positional: readonly string[]): Env {
  const alias = positional[0];
  if (alias === undefined) throw new Error(`Missing <env>.\n\n${USAGE}`);
  return resolveEnv(alias);
}

function listWorkloads(env: Env) {
  return parseWorkloads(kubectl(env, ["get", "deploy,sts", "-o", "json"]).stdout);
}

function cmdEnvs(verify: boolean): void {
  const rows = [
    ["ALIAS", "STAGE", "CLUSTER", "NAMESPACE"],
    ...REAL_ENVS.map((e) => [e.alias, e.stage, e.cluster, e.namespace]),
    ["sbx:<name>", "SBX", SBX_CLUSTER, "minivault-<name>-sbx"],
  ];
  console.log(formatTable(rows).join("\n"));
  if (!verify) return;
  const result = spawnSync("tsh", ["kube", "ls", "-f", "json"], { encoding: "utf8" });
  const login = "Run: tsh login --proxy=teleport.ledgerlabs.net";
  if (result.error || result.status !== 0) {
    throw new KubeError(
      `tsh kube ls failed: ${result.error?.message ?? result.stderr?.trim() ?? "unknown error"}\n${login}`,
    );
  }
  let listed: { kube_cluster_name: string }[];
  try {
    listed = JSON.parse(result.stdout) as { kube_cluster_name: string }[];
  } catch {
    throw new KubeError(`tsh kube ls returned invalid JSON.\n${login}`);
  }
  const available = new Set(listed.map((c) => c.kube_cluster_name));
  const wanted = [...new Set([...REAL_ENVS.map((e) => e.cluster), SBX_CLUSTER])];
  for (const cluster of wanted) {
    console.log(
      `${available.has(cluster) ? "ok     " : "MISSING"} ${cluster} (${kubeContext(cluster)})`,
    );
  }
  if (wanted.some((cluster) => !available.has(cluster))) process.exitCode = 1;
}

function cmdPods(env: Env, grep: string | undefined): void {
  const regex = compileGrep(grep);
  const [header = "", ...rows] = kubectl(env, ["get", "pods"]).stdout.trimEnd().split("\n");
  print(keepFirstLines([header, ...grepLines(rows, regex)], MAX_TABLE_LINES));
}

function cmdLogs(env: Env, app: string, flags: ReadonlyMap<string, string>): void {
  const options = {
    tail: validateTail(flags.get("tail"), DEFAULT_TAIL),
    since: flags.get("since") ?? DEFAULT_SINCE,
    grep: flags.get("grep"),
  };
  compileGrep(options.grep);
  const workload = resolveWorkload(listWorkloads(env), app, env.alias);
  const { stdout, stderr } = kubectl(env, buildLogsArgs(workload, options));
  const grepNote = options.grep === undefined ? "" : ` grep=/${options.grep}/i`;
  console.log(
    `[vault-env] ${env.alias}/${workload.name} since=${options.since} tail=${options.tail}${grepNote}`,
  );
  for (const warning of stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(0, 5)) {
    console.log(`[vault-env] kubectl: ${warning}`);
  }
  print(processLogs(stdout, options));
}

function cmdVersion(env: Env, app: string | undefined): void {
  const matched = filterWorkloads(listWorkloads(env), app);
  if (matched.length === 0) throw new Error(`No workload matching "${app ?? ""}" in ${env.alias}.`);
  const rows = [
    ["WORKLOAD", "IMAGE", "TAG", "READY", "ARGOCD APP"],
    ...matched.map((w) => [w.name, w.image, w.tag, w.ready, w.argoApp]),
  ];
  print(keepFirstLines(formatTable(rows), MAX_TABLE_LINES));
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  const spec = command === undefined ? undefined : FLAGS[command];
  if (command === undefined || spec === undefined) {
    console.log(USAGE);
    if (command !== undefined && command !== "help" && command !== "--help") process.exitCode = 2;
    return;
  }
  if (command === "name") return console.log(sanitizeInstanceName(rest.join(" ")));
  const { positional, flags } = parseArgs(command, rest, spec);
  switch (command) {
    case "envs":
      return cmdEnvs(flags.has("verify"));
    case "pods":
      return cmdPods(requireEnv(positional), flags.get("grep"));
    case "logs": {
      const app = positional[1];
      if (app === undefined) throw new Error(`Missing <app>.\n\n${USAGE}`);
      return cmdLogs(requireEnv(positional), app, flags);
    }
    case "version":
      return cmdVersion(requireEnv(positional), positional[1]);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
