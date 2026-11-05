import { describe, expect, test } from "bun:test";
import { resolveEnv } from "./envs.ts";
import { explainKubeFailure } from "./kube.ts";

const prd = resolveEnv("vault-prd");

describe("explainKubeFailure", () => {
  test("prints tsh commands when the kube context or session is missing", () => {
    for (const stderr of [
      'error: context "x" does not exist',
      "error: the server has asked for the client to provide credentials (Unauthorized)",
      "x509: certificate has expired",
      "You must login to Teleport",
      "Unable to connect: getting credentials: exec: executable tsh failed with exit code 1",
    ]) {
      const message = explainKubeFailure(prd, stderr);
      expect(message).toContain("tsh kube login shared-application-2026-cluster");
    }
  });

  test("reports a missing role, not a login, on Forbidden", () => {
    const message = explainKubeFailure(prd, 'pods is forbidden: User "x" cannot list resource');
    expect(message).toContain("role is missing");
    expect(message).not.toContain("tsh kube login");
  });

  test("passes other errors through untouched", () => {
    expect(
      explainKubeFailure(prd, 'Error from server (NotFound): deployments "x" not found\n'),
    ).toBe('Error from server (NotFound): deployments "x" not found');
    expect(explainKubeFailure(prd, "dial tcp: i/o timeout")).not.toContain("tsh kube login");
  });
});
