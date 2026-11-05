import { describe, expect, test } from "bun:test";
import { REAL_ENVS, resolveEnv, sanitizeInstanceName } from "./envs.ts";

describe("resolveEnv", () => {
  test("maps real aliases to the -argocd namespaces on the right cluster", () => {
    expect(resolveEnv("vault-prd")).toMatchObject({
      stage: "PRD",
      cluster: "shared-application-2026-cluster",
      namespace: "2108-vault-prd-argocd",
    });
    expect(resolveEnv("vault-ppr2")).toMatchObject({
      stage: "PPR",
      cluster: "shared-application-2094-cluster",
      namespace: "2090-vault-ppr2-argocd",
    });
    expect(resolveEnv("vault-next")).toMatchObject({
      stage: "STG",
      cluster: "shared-application-2021-cluster",
      namespace: "2043-vault-next",
    });
  });

  test("never aliases a legacy non-argocd PPR/PRD namespace", () => {
    for (const env of REAL_ENVS.filter((e) => e.stage !== "STG"))
      expect(env.namespace.endsWith("-argocd")).toBe(true);
  });

  test("maps sbx:<name> to the SBX instance namespace", () => {
    expect(resolveEnv("sbx:meri-webapp2")).toMatchObject({
      kind: "disposable",
      cluster: "sandbox-2042-cluster",
      namespace: "minivault-meri-webapp2-sbx",
    });
  });

  test("rejects unknown aliases and invalid instance names", () => {
    expect(() => resolveEnv("vault-nope")).toThrow(/Known aliases/);
    expect(() => resolveEnv("sbx:Bad_Name")).toThrow(/Invalid instance name/);
    expect(() => resolveEnv("sbx:a;rm")).toThrow(/Invalid instance name/);
  });
});

describe("sanitizeInstanceName", () => {
  test("lowercases and replaces illegal characters with single hyphens", () => {
    expect(sanitizeInstanceName("repro VG-1234")).toBe("repro-vg-1234");
    expect(sanitizeInstanceName("  Hello__World!! ")).toBe("hello-world");
  });

  test("truncates to 20 chars without a trailing hyphen", () => {
    const name = sanitizeInstanceName("repro-vg1234-balance-bug-on-eth");
    expect(name.length).toBeLessThanOrEqual(20);
    expect(name).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(sanitizeInstanceName("abcdefghijklmnopqrs-tuvw")).toBe("abcdefghijklmnopqrs");
  });

  test("throws when nothing valid remains", () => {
    expect(() => sanitizeInstanceName("!!!")).toThrow();
  });
});
