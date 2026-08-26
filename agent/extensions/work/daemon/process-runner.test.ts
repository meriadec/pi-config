import { describe, expect, test } from "bun:test";
import { LocalProcessRunner } from "./process-runner.ts";

describe("local process environment", () => {
  test("removes repository-local Git context after applying explicit environment", async () => {
    const result = await new LocalProcessRunner().run({
      command: process.execPath,
      args: [
        "-e",
        "console.log(JSON.stringify({ gitIndex: process.env.GIT_INDEX_FILE, sentinel: process.env.SENTINEL }))",
      ],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      env: { GIT_INDEX_FILE: ".git/index", SENTINEL: "present" },
      unsetEnv: ["GIT_INDEX_FILE"],
    });

    expect(result).toMatchObject({ status: "completed", exitCode: 0, outputTruncated: false });
    expect(JSON.parse(result.stdout)).toEqual({ sentinel: "present" });
  });
});
