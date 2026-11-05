#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  REAL_ENVS,
  kubeContext,
  resolveEnv,
  sanitizeInstanceName,
  SBX_CLUSTER,
  type Env,
} from "../src/envs.ts";
import { KubeError, kubectl } from "../src/kube.ts";
import {
  DEFAULT_SINCE,
  DEFAULT_TAIL,
  MAX_TABLE_LINES,
  MAX_TAIL,
  filterWorkloads,
  formatTable,
  grepLines,
  keepFirstLines,
  keepLastLines,
  parseWorkloads,
  type Capped,
} from "../src/text.ts";

const USAGE = `vault-env: read-only view of Ledger Vault envs (never writes).

  envs [--verify]                         List aliases. --verify compares with \`tsh kube ls\`.
  pods <env> [--grep RE]                  Pods of an env.
  logs <env> <app> [--tail N] [--since D] [--grep RE]
                                          Logs of a workload. Defaults: --tail ${DEFAULT_TAIL} --since ${DEFAULT_SINCE}, max --tail ${MAX_TAIL}.
  version <env> [app]                     Live image tag, ready replicas, ArgoCD app per workload.
  name <text>                             Valid vault-remote instance name from free text.

<env>: ${REAL_ENVS.map((e) => e.alias).join(" | ")} | sbx:<instance-name>`;

interface Parsed {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["verify"]);

function parseArgs(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags.set(key, "true");
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`Flag --${key} needs a value.`);
    flags.set(key, value);
  }
  return { positional, flags };
}

function print(capped: Capped): void {
  if (capped.text !== "") console.log(capped.text);
  if (capped.notice !== undefined) console.log(`[vault-env] ${capped.notice}`);
}

function requireEnv(positional: readonly string[]): Env {
  const alias = positional[0];
  if (alias === undefined) throw new Error("Missing <env>.\n\n" + USAGE);
  return resolveEnv(alias);
}

interface WorkloadList {
  readonly workloads: ReturnType<typeof parseWorkloads>;
  readonly raw: {
    items?: {
      kind?: string;
      metadata?: { name?: string };
      spec?: { selector?: { matchLabels?: Record<string, string> } };
    }[];
  };
}

function listWorkloads(env: Env): WorkloadList {
  const json = kubectl(env, ["get", "deploy,sts", "-o", "json"]);
  return { workloads: parseWorkloads(json), raw: JSON.parse(json) };
}

function cmdEnvs(flags: ReadonlyMap<string, string>): void {
  const rows = [
    ["ALIAS", "STAGE", "CLUSTER", "NAMESPACE"],
    ...REAL_ENVS.map((e) => [e.alias, e.stage, e.cluster, e.namespace]),
    ["sbx:<name>", "SBX", SBX_CLUSTER, "minivault-<name>-sbx"],
  ];
  console.log(formatTable(rows).join("\n"));
  if (!flags.has("verify")) return;
  const result = spawnSync("tsh", ["kube", "ls", "-f", "json"], { encoding: "utf8" });
  if (result.status !== 0)
    throw new KubeError(
      `tsh kube ls failed: ${result.stderr.trim()}\nRun: tsh login --proxy=teleport.ledgerlabs.net`,
    );
  const available = new Set(
    (JSON.parse(result.stdout) as { kube_cluster_name: string }[]).map((c) => c.kube_cluster_name),
  );
  const wanted = [...new Set([...REAL_ENVS.map((e) => e.cluster), SBX_CLUSTER])];
  const missing = wanted.filter((cluster) => !available.has(cluster));
  for (const cluster of wanted)
    console.log(
      `${available.has(cluster) ? "ok     " : "MISSING"} ${cluster} (${kubeContext(cluster)})`,
    );
  if (missing.length > 0) process.exitCode = 1;
}

function cmdPods(env: Env, flags: ReadonlyMap<string, string>): void {
  const [header = "", ...rows] = kubectl(env, ["get", "pods"]).trimEnd().split("\n");
  const filtered = grepLines(rows, flags.get("grep"));
  print(keepFirstLines([header, ...filtered], MAX_TABLE_LINES));
}

function resolveWorkloadName(env: Env, query: string): string {
  const { workloads } = listWorkloads(env);
  const exact = workloads.find((w) => w.name === query);
  if (exact) return exact.name;
  const candidates = workloads.filter((w) => w.name.includes(query));
  if (candidates.length === 1) return candidates[0]!.name;
  const shown =
    candidates
      .slice(0, 15)
      .map((w) => w.name)
      .join(", ") || "(none)";
  const list = candidates.length > 15 ? `${shown}, … (${candidates.length - 15} more)` : shown;
  throw new Error(`"${query}" matches ${candidates.length} workloads in ${env.alias}: ${list}`);
}

function timestampOf(line: string): string {
  return /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(line)?.[0] ?? "";
}

function cmdLogs(env: Env, app: string, flags: ReadonlyMap<string, string>): void {
  const tail = Number(flags.get("tail") ?? DEFAULT_TAIL);
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL)
    throw new Error(`--tail must be an integer from 1 to ${MAX_TAIL}.`);
  const since = flags.get("since") ?? DEFAULT_SINCE;
  const grep = flags.get("grep");
  const name = resolveWorkloadName(env, app);
  const { raw } = listWorkloads(env);
  const item = raw.items?.find((candidate) => candidate.metadata?.name === name);
  const selector = Object.entries(item?.spec?.selector?.matchLabels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  if (selector === "") throw new Error(`No pod selector found for ${name}.`);
  // With --grep, scan a wider window per pod, then keep the last matches.
  const fetch = grep === undefined ? tail : MAX_TAIL;
  const out = kubectl(env, [
    "logs",
    "-l",
    selector,
    `--tail=${fetch}`,
    `--since=${since}`,
    "--timestamps",
    "--prefix",
    "--max-log-requests=20",
    "--ignore-errors",
  ]);
  const lines = out.split("\n").filter((line) => line !== "");
  const sorted = [...lines].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
  console.log(
    `[vault-env] ${env.alias}/${name} since=${since} tail=${tail}${grep === undefined ? "" : ` grep=/${grep}/i`}`,
  );
  print(keepLastLines(grepLines(sorted, grep), tail));
}

function cmdVersion(env: Env, app: string | undefined): void {
  const { workloads } = listWorkloads(env);
  const matched = filterWorkloads(workloads, app);
  if (matched.length === 0) throw new Error(`No workload matching "${app ?? ""}" in ${env.alias}.`);
  const rows = [
    ["WORKLOAD", "IMAGE", "TAG", "READY", "ARGOCD APP"],
    ...matched.map((w) => [w.name, w.image, w.tag, w.ready, w.argoApp]),
  ];
  print(keepFirstLines(formatTable(rows), MAX_TABLE_LINES));
}

function main(argv: readonly string[]): void {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "envs":
      return cmdEnvs(flags);
    case "pods":
      return cmdPods(requireEnv(positional), flags);
    case "logs": {
      const app = positional[1];
      if (app === undefined) throw new Error("Missing <app>.\n\n" + USAGE);
      return cmdLogs(requireEnv(positional), app, flags);
    }
    case "version":
      return cmdVersion(requireEnv(positional), positional[1]);
    case "name":
      return console.log(sanitizeInstanceName(positional.join(" ")));
    default:
      console.log(USAGE);
      if (command !== undefined && command !== "help" && command !== "--help") process.exitCode = 2;
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
