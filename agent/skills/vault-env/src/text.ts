export const DEFAULT_TAIL = 200;
export const DEFAULT_SINCE = "15m";
export const MAX_TAIL = 2000;
export const MAX_TABLE_LINES = 200;

export interface Capped {
  readonly text: string;
  readonly notice: string | undefined;
}

/** Keep the last `max` lines. Logs matter most at the end. */
export function keepLastLines(lines: readonly string[], max: number): Capped {
  if (lines.length <= max) return { text: lines.join("\n"), notice: undefined };
  const dropped = lines.length - max;
  return {
    text: lines.slice(-max).join("\n"),
    notice: `truncated, ${dropped} more line${dropped === 1 ? "" : "s"} not shown`,
  };
}

/** Keep the first `max` lines. Tables list the head. */
export function keepFirstLines(lines: readonly string[], max: number): Capped {
  if (lines.length <= max) return { text: lines.join("\n"), notice: undefined };
  const dropped = lines.length - max;
  return {
    text: lines.slice(0, max).join("\n"),
    notice: `truncated, ${dropped} more line${dropped === 1 ? "" : "s"} not shown`,
  };
}

export function grepLines(
  lines: readonly string[],
  pattern: string | undefined,
): readonly string[] {
  if (pattern === undefined) return lines;
  const regex = new RegExp(pattern, "i");
  return lines.filter((line) => regex.test(line));
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
}

interface KubeWorkloadItem {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: { replicas?: number; template?: { spec?: { containers?: { image?: string }[] } } };
  status?: { readyReplicas?: number };
}

export function parseWorkloads(json: string): readonly Workload[] {
  const items = (JSON.parse(json) as { items?: KubeWorkloadItem[] }).items ?? [];
  return items.map((item) => {
    const imageRef = item.spec?.template?.spec?.containers?.[0]?.image ?? "?";
    const { repo, tag } = parseImage(imageRef);
    const tracking = item.metadata?.annotations?.["argocd.argoproj.io/tracking-id"];
    return {
      kind: item.kind ?? "?",
      name: item.metadata?.name ?? "?",
      image: repo.slice(repo.lastIndexOf("/") + 1),
      tag,
      ready: `${item.status?.readyReplicas ?? 0}/${item.spec?.replicas ?? 0}`,
      argoApp: tracking?.split(":")[0] ?? "-",
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
