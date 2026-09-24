#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createPullRequest,
  inspectRepository,
  WorkflowError,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type CreateOptions,
} from "../src/workflow.ts";

class ProcessRunner implements CommandRunner {
  run(request: CommandRequest): CommandResult {
    const result = spawnSync(request.command, request.args, {
      cwd: process.cwd(),
      encoding: "utf8",
      input: request.input,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    if (result.error) {
      return { exitCode: 127, stdout: result.stdout ?? "", stderr: result.error.message };
    }
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

function main(argv: string[]): number {
  try {
    const [command, ...args] = argv;
    const runner = new ProcessRunner();
    if (command === "inspect") {
      const parsed = parseArguments(args, new Set(["base"]), new Set());
      const inspection = inspectRepository(runner, parsed.values.get("base"));
      printJson({ ok: true, code: "inspected", ...inspection });
      return 0;
    }
    if (command === "create") {
      const parsed = parseArguments(
        args,
        new Set(["base", "head", "title", "label"]),
        new Set(["confirmed", "draft"]),
      );
      const options: CreateOptions = {
        confirmed: parsed.flags.has("confirmed"),
        head: requiredValue(parsed.values, "head"),
        title: requiredValue(parsed.values, "title"),
        body: readFileSync(0, "utf8"),
        draft: parsed.flags.has("draft"),
        labels: parsed.repeatedValues.get("label") ?? [],
      };
      const base = parsed.values.get("base");
      if (base !== undefined) options.base = base;
      const result = createPullRequest(runner, options);
      printJson(result);
      return result.ok ? 0 : 1;
    }
    throw new WorkflowError(
      "usage",
      "Usage: create-pr.ts inspect [--base BRANCH] | create [options]",
    );
  } catch (error) {
    if (error instanceof WorkflowError) {
      printJson({ ok: false, code: error.code, message: error.message, ...error.details });
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    printJson({ ok: false, code: "unexpected_error", message });
    return 1;
  }
}

interface ParsedArguments {
  values: Map<string, string>;
  repeatedValues: Map<string, string[]>;
  flags: Set<string>;
}

function parseArguments(
  args: string[],
  valueOptions: Set<string>,
  flagOptions: Set<string>,
): ParsedArguments {
  const values = new Map<string, string>();
  const repeatedValues = new Map<string, string[]>();
  const flags = new Set<string>();

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--"))
      throw new WorkflowError("usage", `Unexpected argument: ${argument ?? ""}`);
    const name = argument.slice(2);
    if (flagOptions.has(name)) {
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new WorkflowError("usage", `Unknown option: --${name}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new WorkflowError("usage", `Option --${name} requires a value.`);
    }
    index += 1;
    if (name === "label") {
      const collected = repeatedValues.get(name) ?? [];
      collected.push(value);
      repeatedValues.set(name, collected);
    } else if (values.has(name)) {
      throw new WorkflowError("usage", `Option --${name} can be provided only once.`);
    } else {
      values.set(name, value);
    }
  }

  return { values, repeatedValues, flags };
}

function requiredValue(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new WorkflowError("usage", `Option --${name} is required.`);
  return value;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

process.exitCode = main(process.argv.slice(2));
