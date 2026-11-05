import { describe, expect, test } from "bun:test";
import { MAX_LINE_CHARS, MAX_LOG_BYTES, buildLogsArgs, processLogs, validateTail } from "./logs.ts";
import type { Workload } from "./text.ts";

const WORKLOAD: Workload = {
  kind: "Deployment",
  name: "api",
  image: "api",
  tag: "1",
  ready: "1/1",
  argoApp: "-",
  selector: "app=api",
};
const line = (second: number, pod: string, msg: string) =>
  `[pod/${pod}/c] 2026-01-01T00:00:${String(second).padStart(2, "0")}.000000000Z ${msg}`;

describe("buildLogsArgs", () => {
  test("reads all pods and all containers with the workload selector", () => {
    const args = buildLogsArgs(WORKLOAD, { tail: 50, since: "15m", grep: undefined });
    expect(args).toEqual(
      expect.arrayContaining([
        "-l",
        "app=api",
        "--tail=50",
        "--since=15m",
        "--all-containers",
        "--prefix",
        "--timestamps",
      ]),
    );
  });

  test("scans a wider window per pod when grepping", () => {
    expect(buildLogsArgs(WORKLOAD, { tail: 5, since: "1h", grep: "err" })).toContain("--tail=2000");
  });

  test("fails without a selector", () => {
    expect(() =>
      buildLogsArgs({ ...WORKLOAD, selector: "" }, { tail: 5, since: "1h", grep: undefined }),
    ).toThrow(/No pod selector/);
  });
});

describe("validateTail", () => {
  test("accepts 1..2000 and rejects the rest", () => {
    expect(validateTail(undefined, 200)).toBe(200);
    expect(validateTail("2000", 200)).toBe(2000);
    for (const bad of ["0", "2001", "1.5", "abc"])
      expect(() => validateTail(bad, 200)).toThrow(/--tail/);
  });
});

describe("processLogs", () => {
  test("merges pods by timestamp and keeps the last lines with a notice", () => {
    const raw = [line(3, "b", "three"), line(1, "a", "one"), line(2, "a", "two")].join("\n");
    const capped = processLogs(raw, { tail: 2, since: "15m", grep: undefined });
    expect(capped.text.split("\n").map((l) => l.split("Z ")[1])).toEqual(["two", "three"]);
    expect(capped.notice).toBe("truncated, 1 more line not shown");
  });

  test("greps the whole line, then caps", () => {
    const raw = [line(1, "a", "ok"), line(2, "a", "ERROR boom"), line(3, "a", "ok")].join("\n");
    const capped = processLogs(raw, { tail: 10, since: "15m", grep: "error" });
    expect(capped.text).toContain("ERROR boom");
    expect(capped.text).not.toContain("ok");
  });

  test("says so when nothing is left", () => {
    expect(processLogs("", { tail: 10, since: "15m", grep: undefined })).toEqual({
      text: "",
      notice: "no log lines in the last 15m",
    });
    expect(processLogs(line(1, "a", "x"), { tail: 10, since: "1h", grep: "zzz" }).notice).toBe(
      "no log lines matching /zzz/i in the last 1h",
    );
  });

  test("shortens very long lines and says so", () => {
    const capped = processLogs(line(1, "a", "x".repeat(5000)), {
      tail: 10,
      since: "15m",
      grep: undefined,
    });
    expect(capped.text.length).toBeLessThanOrEqual(MAX_LINE_CHARS + 1);
    expect(capped.notice).toContain("shortened");
  });

  test("caps total bytes, dropping the oldest lines", () => {
    const raw = Array.from({ length: 1000 }, (_, i) => line(i % 60, "a", "y".repeat(400))).join(
      "\n",
    );
    const capped = processLogs(raw, { tail: 1000, since: "15m", grep: undefined });
    expect(Buffer.byteLength(capped.text)).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(capped.notice).toContain("size cap");
  });
});
