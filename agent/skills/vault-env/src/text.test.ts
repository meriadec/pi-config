import { describe, expect, test } from "bun:test";
import {
  filterWorkloads,
  grepLines,
  keepFirstLines,
  keepLastLines,
  parseImage,
  parseWorkloads,
} from "./text.ts";

describe("keepLastLines", () => {
  test("keeps the tail and reports the dropped count", () => {
    const capped = keepLastLines(["a", "b", "c", "d"], 2);
    expect(capped.text).toBe("c\nd");
    expect(capped.notice).toBe("truncated, 2 more lines not shown");
  });
  test("returns everything without notice under the cap", () => {
    expect(keepLastLines(["a"], 2)).toEqual({ text: "a", notice: undefined });
  });
});

describe("keepFirstLines", () => {
  test("keeps the head", () => {
    expect(keepFirstLines(["a", "b", "c"], 1).text).toBe("a");
  });
});

describe("grepLines", () => {
  test("filters case-insensitively and passes through without a pattern", () => {
    expect(grepLines(["Error x", "ok"], "error")).toEqual(["Error x"]);
    expect(grepLines(["a", "b"], undefined)).toEqual(["a", "b"]);
  });
});

describe("parseImage", () => {
  test("handles tags, registry ports, digests and missing tags", () => {
    expect(parseImage("jfrog.x/vault/les-wallet:0.58.0")).toEqual({
      repo: "jfrog.x/vault/les-wallet",
      tag: "0.58.0",
    });
    expect(parseImage("reg:5000/app:1.2")).toEqual({ repo: "reg:5000/app", tag: "1.2" });
    expect(parseImage("reg:5000/app").tag).toBe("latest");
    expect(parseImage("r/app:main@sha256:abefa15ceb46770c6beaf").tag).toBe(
      "main@sha256:abefa15ceb46",
    );
  });
});

const KUBE_JSON = JSON.stringify({
  items: [
    {
      kind: "Deployment",
      metadata: {
        name: "les-wallet-api",
        annotations: {
          "argocd.argoproj.io/tracking-id":
            "vault-les-wallet-prd:apps/Deployment:ns/les-wallet-api",
        },
      },
      spec: {
        replicas: 2,
        template: { spec: { containers: [{ image: "jfrog/x/les-wallet:0.58.0" }] } },
      },
      status: { readyReplicas: 1 },
    },
    {
      kind: "Deployment",
      metadata: { name: "front" },
      spec: {
        replicas: 1,
        template: { spec: { containers: [{ image: "jfrog/x/ledger-vault-front:8.1.0" }] } },
      },
      status: {},
    },
  ],
});

describe("parseWorkloads / filterWorkloads", () => {
  test("extracts tag, ready count and ArgoCD app", () => {
    const [first, second] = parseWorkloads(KUBE_JSON);
    expect(first).toMatchObject({
      name: "les-wallet-api",
      image: "les-wallet",
      tag: "0.58.0",
      ready: "1/2",
      argoApp: "vault-les-wallet-prd",
    });
    expect(second).toMatchObject({ ready: "0/1", argoApp: "-" });
  });
  test("matches by workload name or image name", () => {
    const all = parseWorkloads(KUBE_JSON);
    expect(filterWorkloads(all, "les-wallet").map((w) => w.name)).toEqual(["les-wallet-api"]);
    expect(filterWorkloads(all, "vault-front").map((w) => w.name)).toEqual(["front"]);
  });
});
