import { expect, test } from "bun:test";
import { redact } from "./redact.ts";

test("env style secrets keep the name and lose the value", () => {
  expect(redact("export T3_MCP_BEARER_TOKEN=48ivy6X7kV_Y02GpMqEaPh2Eefo9dDz7ejNi_lKC52Q")).toBe(
    "export T3_MCP_BEARER_TOKEN=<redacted>",
  );
});
test("api keys, github tokens, jwt and url credentials are removed", () => {
  const out = redact(
    "sk-abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstuvwxyz0123 https://u:pw@host.io/x eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
  );
  expect(out).not.toMatch(/sk-abc|ghp_abc|u:pw|eyJhb/);
});
test("emails and long hashes are removed; normal words stay", () => {
  expect(
    redact("mail a.b@corp.com sha 3678d4b394643cdc10683974bd1f9261ddcb9eeb fix the table"),
  ).toBe("mail <email> sha <hex> fix the table");
});
