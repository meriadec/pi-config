import { spawnSync } from "node:child_process";
import { kubeContext, type Env } from "./envs.ts";
import { assertReadOnly } from "./guard.ts";

const MAX_BUFFER = 32 * 1024 * 1024;
const LOGIN_FAILURE =
  /context was not found|context .* does not exist|unauthorized|certificate has expired|must login|must be logged in|not logged in|please login|tsh kube login|getting credentials|executable tsh failed|session has expired/i;
const FORBIDDEN = /forbidden/i;

export class KubeError extends Error {}

export function loginHint(env: Env): string {
  return [
    `Teleport session missing or expired for ${env.stage} (${env.cluster}). Run, then retry:`,
    "  tsh login --proxy=teleport.ledgerlabs.net",
    `  tsh kube login ${env.cluster}`,
    "This CLI never logs in.",
  ].join("\n");
}

/** Turn kubectl stderr into an actionable message. */
export function explainKubeFailure(env: Env, stderr: string): string {
  const text = stderr.trim();
  if (LOGIN_FAILURE.test(text)) return `${loginHint(env)}\n\nkubectl said: ${text}`;
  if (FORBIDDEN.test(text)) {
    return `Access denied on ${env.stage} (${env.cluster}): the Teleport role is missing. Ask the user to request it.\n\nkubectl said: ${text}`;
  }
  return text;
}

export interface KubeOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a read-only kubectl command in an env's cluster and namespace. */
export function kubectl(env: Env, args: readonly string[]): KubeOutput {
  const full = ["--context", kubeContext(env.cluster), "-n", env.namespace, ...args];
  assertReadOnly(full);
  const result = spawnSync("kubectl", full, { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOBUFS") {
      throw new KubeError("kubectl output is too large. Narrow it with --since or --grep.");
    }
    throw new KubeError(`kubectl failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) throw new KubeError(explainKubeFailure(env, result.stderr));
  return { stdout: result.stdout, stderr: result.stderr };
}
