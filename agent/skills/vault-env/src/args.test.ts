import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

const SPEC = { tail: "string", verify: "boolean" } as const;

describe("parseArgs", () => {
  test("parses positional, --k v, --k=v and booleans", () => {
    const parsed = parseArgs("logs", ["vault-next", "--tail", "5", "app", "--verify"], SPEC);
    expect(parsed.positional).toEqual(["vault-next", "app"]);
    expect(parsed.flags.get("tail")).toBe("5");
    expect(parsed.flags.get("verify")).toBe("true");
    expect(parseArgs("logs", ["--tail=7"], SPEC).flags.get("tail")).toBe("7");
  });

  test("rejects unknown flags without swallowing the next argument", () => {
    expect(() => parseArgs("logs", ["--bogus", "x"], SPEC)).toThrow(/Unknown flag --bogus.*--tail/);
  });

  test("rejects a value flag without a value", () => {
    expect(() => parseArgs("logs", ["--tail"], SPEC)).toThrow(/needs a value/);
  });
});
