export type EnvKind = "real" | "disposable";

export interface Env {
  readonly alias: string;
  readonly kind: EnvKind;
  readonly stage: "STG" | "PPR" | "PRD" | "SBX";
  /** Teleport kube cluster name, as listed by `tsh kube ls`. */
  readonly cluster: string;
  readonly namespace: string;
}

const REAL: readonly Omit<Env, "kind">[] = [
  {
    alias: "vault-next",
    stage: "STG",
    cluster: "shared-application-2021-cluster",
    namespace: "2043-vault-next",
  },
  {
    alias: "vault-main",
    stage: "STG",
    cluster: "shared-application-2021-cluster",
    namespace: "2063-vault-main",
  },
  {
    alias: "vault-load",
    stage: "STG",
    cluster: "shared-application-2021-cluster",
    namespace: "2087-vault-load",
  },
  {
    alias: "vault-ppr",
    stage: "PPR",
    cluster: "shared-application-2094-cluster",
    namespace: "2060-vault-ppr-argocd",
  },
  {
    alias: "vault-ppr2",
    stage: "PPR",
    cluster: "shared-application-2094-cluster",
    namespace: "2090-vault-ppr2-argocd",
  },
  {
    alias: "vault-prd",
    stage: "PRD",
    cluster: "shared-application-2026-cluster",
    namespace: "2108-vault-prd-argocd",
  },
];

export const SBX_CLUSTER = "sandbox-2042-cluster";
export const SBX_PREFIX = "sbx:";
const SBX_NAMESPACE_PREFIX = "minivault-";
const SBX_NAMESPACE_SUFFIX = "-sbx";

export const REAL_ENVS: readonly Env[] = REAL.map((env) => ({ ...env, kind: "real" as const }));

export function kubeContext(cluster: string): string {
  return `teleport.ledgerlabs.net-${cluster}`;
}

/** Resolve `vault-next`, `vault-prd`, ... or `sbx:<instance-name>`. */
export function resolveEnv(alias: string): Env {
  if (alias.startsWith(SBX_PREFIX)) {
    const name = alias.slice(SBX_PREFIX.length);
    if (!/^[a-z0-9]([a-z0-9-]{0,18}[a-z0-9])?$/.test(name)) {
      throw new Error(
        `Invalid instance name "${name}": lowercase letters, digits and "-", 20 chars max.`,
      );
    }
    return {
      alias,
      kind: "disposable",
      stage: "SBX",
      cluster: SBX_CLUSTER,
      namespace: `${SBX_NAMESPACE_PREFIX}${name}${SBX_NAMESPACE_SUFFIX}`,
    };
  }
  const env = REAL_ENVS.find((candidate) => candidate.alias === alias);
  if (!env) {
    const known = REAL_ENVS.map((candidate) => candidate.alias).join(", ");
    throw new Error(
      `Unknown env "${alias}". Known aliases: ${known}. Disposable instance: ${SBX_PREFIX}<name>.`,
    );
  }
  return env;
}

/** Turn free text (ticket id, title) into a valid vault-remote instance name. */
export function sanitizeInstanceName(input: string): string {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 20)
    .replace(/-+$/, "");
  if (name === "") throw new Error(`Cannot derive an instance name from "${input}".`);
  return name;
}
