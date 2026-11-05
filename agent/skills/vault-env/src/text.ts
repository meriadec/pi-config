export const DEFAULT_TAIL = 200;
export const DEFAULT_SINCE = "15m";
export const MAX_TAIL = 2000;
export const MAX_TABLE_LINES = 200;
export const MAX_GREP_LENGTH = 200;

export interface Capped {
  readonly text: string;
  readonly notice: string | undefined;
}

function droppedNotice(dropped: number): string {
  return `truncated, ${dropped} more line${dropped === 1 ? "" : "s"} not shown`;
}

/** Keep the last `max` lines. Logs matter most at the end. */
export function keepLastLines(lines: readonly string[], max: number): Capped {
  if (lines.length <= max) return { text: lines.join("\n"), notice: undefined };
  return { text: lines.slice(-max).join("\n"), notice: droppedNotice(lines.length - max) };
}

/** Keep the first `max` lines. Tables list the head. */
export function keepFirstLines(lines: readonly string[], max: number): Capped {
  if (lines.length <= max) return { text: lines.join("\n"), notice: undefined };
  return { text: lines.slice(0, max).join("\n"), notice: droppedNotice(lines.length - max) };
}

/** Compile a user regex once, with a readable error. Call before any remote work. */
export function compileGrep(pattern: string | undefined): RegExp | undefined {
  if (pattern === undefined) return undefined;
  if (pattern.length > MAX_GREP_LENGTH)
    throw new Error(`--grep is limited to ${MAX_GREP_LENGTH} characters.`);
  try {
    return new RegExp(pattern, "i");
  } catch (error) {
    throw new Error(
      `Invalid --grep regex: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function grepLines(lines: readonly string[], regex: RegExp | undefined): readonly string[] {
  return regex === undefined ? lines : lines.filter((line) => regex.test(line));
}

export function parseImage(image: string): { repo: string; tag: string } {
  const [withoutDigest = image, digest] = image.split("@");
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  const hasTag = colon > slash;
  const repo = hasTag ? withoutDigest.slice(0, colon) : withoutDigest;
  const tag = hasTag ? withoutDigest.slice(colon + 1) : "latest";
  return { repo, tag: digest === undefined ? tag : `${tag}@${digest.slice(0, 19)}` };
}

export interface Workload {
  readonly kind: string;
  readonly name: string;
  readonly image: string;
  readonly tag: string;
  readonly ready: string;
  readonly argoApp: string;
  /** `k=v,k=v` from spec.selector.matchLabels, or "" when absent. */
  readonly selector: string;
}

interface KubeContainer {
  name?: string;
  image?: string;
}

interface KubeWorkloadItem {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
    template?: { spec?: { containers?: KubeContainer[] } };
  };
  status?: { readyReplicas?: number };
}

function basename(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}

/** The app container: named like the workload, else image named like it, else the first. */
function pickContainer(
  name: string,
  containers: readonly KubeContainer[],
): KubeContainer | undefined {
  return (
    containers.find((c) => c.name === name) ??
    containers.find(
      (c) => c.image !== undefined && name.includes(basename(parseImage(c.image).repo)),
    ) ??
    containers[0]
  );
}

export function parseWorkloads(json: string): readonly Workload[] {
  const items = (JSON.parse(json) as { items?: KubeWorkloadItem[] }).items ?? [];
  return items.map((item) => {
    const name = item.metadata?.name ?? "?";
    const container = pickContainer(name, item.spec?.template?.spec?.containers ?? []);
    const { repo, tag } = parseImage(container?.image ?? "?");
    const tracking = item.metadata?.annotations?.["argocd.argoproj.io/tracking-id"];
    const rawSelector = item.spec?.selector;
    // matchExpressions cannot be expressed as a simple -l selector: leave it empty so logs fail loudly.
    const selector = rawSelector?.matchExpressions?.length
      ? ""
      : Object.entries(rawSelector?.matchLabels ?? {})
          .map(([key, value]) => `${key}=${value}`)
          .join(",");
    return {
      kind: item.kind ?? "?",
      name,
      image: basename(repo),
      tag,
      ready: `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 0}`,
      argoApp: tracking?.split(":")[0] ?? "-",
      selector,
    };
  });
}

/** Match a workload by deployment name or image name, so `les-wallet` finds `les-wallet-api`. */
export function filterWorkloads(
  workloads: readonly Workload[],
  query: string | undefined,
): readonly Workload[] {
  if (query === undefined) return workloads;
  const needle = query.toLowerCase();
  return workloads.filter(
    (w) => w.name.toLowerCase().includes(needle) || w.image.toLowerCase().includes(needle),
  );
}

export function formatTable(rows: readonly (readonly string[])[]): string[] {
  const widths =
    rows[0]?.map((_, col) => Math.max(...rows.map((row) => (row[col] ?? "").length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, col) => cell.padEnd(widths[col] ?? 0))
      .join("  ")
      .trimEnd(),
  );
}

/** Exact name first, then a unique substring. Otherwise list the candidates. */
export function resolveWorkload(
  workloads: readonly Workload[],
  query: string,
  envAlias: string,
): Workload {
  const exact = workloads.find((w) => w.name === query);
  if (exact) return exact;
  const candidates = workloads.filter((w) => w.name.includes(query));
  if (candidates.length === 1) return candidates[0]!;
  const shown =
    candidates
      .slice(0, 15)
      .map((w) => w.name)
      .join(", ") || "(none)";
  const list = candidates.length > 15 ? `${shown}, … (${candidates.length - 15} more)` : shown;
  throw new Error(`"${query}" matches ${candidates.length} workloads in ${envAlias}: ${list}`);
}
