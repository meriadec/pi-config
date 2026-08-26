/** Makes a Git-safe default and keeps an initial ticket identity readable. */
export function defaultBranchForTopicName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .trim();
  const ticket = /^([A-Za-z]+-\d+)(?:\b|[_\s:—–-]+)/.exec(normalized)?.[1];
  const safe = normalized
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  if (safe.length === 0) return "";
  if (ticket === undefined) return safe.toLowerCase().slice(0, 200).replace(/-$/, "");
  const suffix = safe.slice(ticket.length).replace(/^-/, "").toLowerCase();
  return `${ticket.toUpperCase()}${suffix.length > 0 ? `-${suffix}` : ""}`
    .slice(0, 200)
    .replace(/-$/, "");
}
