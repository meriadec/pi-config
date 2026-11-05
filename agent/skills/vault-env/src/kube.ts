import { spawnSync } from "node:child_process";
import { kubeContext, type Env } from "./envs.ts";
import { assertReadOnly } from "./guard.ts";

const LOGIN_FAILURE =
  /unauthorized|expired|certificate|tsh |tsh:|re-login|must login|not logged in|forbidden|dial tcp|i\/o timeout/i;

export class KubeError extends Error {}

export function loginHint(env: Env): string {
  return [
    `Teleport session missing or expired for ${env.stage} (${env.cluster}). Run, then retry:`,
    "  tsh login --proxy=teleport.ledgerlabs.net",
    `  tsh kube login ${env.cluster}`,
    "If access is denied, request the role in Okta/Teleport. This CLI never logs in.",
  ].join("\n");
}

/** Run a read-only kubectl command in an env's cluster and namespace. */
export function kubectl(env: Env, args: readonly string[]): string {
  const full = ["--context", kubeContext(env.cluster), "-n", env.namespace, ...args];
  assertReadOnly(full);
  const result = spawnSync("kubectl", full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new KubeError(`kubectl failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new KubeError(
      LOGIN_FAILURE.test(stderr) ? `${loginHint(env)}\n\nkubectl said: ${stderr}` : stderr,
    );
  }
  return result.stdout;
}
