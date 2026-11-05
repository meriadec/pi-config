import { describe, expect, test } from "bun:test";
import { assertReadOnly } from "./guard.ts";

describe("assertReadOnly", () => {
  test("allows read verbs after context and namespace flags", () => {
    for (const verb of ["get", "logs", "describe", "top"]) {
      expect(() => assertReadOnly(["--context", "c", "-n", "ns", verb, "pods"])).not.toThrow();
    }
  });

  test("refuses every mutating verb", () => {
    for (const verb of [
      "delete",
      "apply",
      "rollout",
      "scale",
      "exec",
      "patch",
      "edit",
      "replace",
      "port-forward",
      "cp",
      "annotate",
    ]) {
      expect(() => assertReadOnly(["--context", "c", "-n", "ns", verb, "x"])).toThrow(
        /not read-only/,
      );
    }
  });

  test("a flag value that looks like a read verb does not hide a write verb", () => {
    expect(() => assertReadOnly(["--context", "get", "-n", "logs", "delete", "pod", "x"])).toThrow(
      /not read-only/,
    );
  });
});
