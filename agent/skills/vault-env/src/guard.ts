/** The CLI only reads. Every kubectl call goes through this allowlist. */
const READ_ONLY_VERBS: ReadonlySet<string> = new Set(["get", "logs", "describe", "top"]);
const FLAGS_WITH_VALUE: ReadonlySet<string> = new Set(["--context", "-n", "--namespace"]);

function verbOf(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return undefined;
}

export function assertReadOnly(kubectlArgs: readonly string[]): void {
  const verb = verbOf(kubectlArgs);
  if (verb === undefined || !READ_ONLY_VERBS.has(verb)) {
    throw new Error(
      `Refused: kubectl "${verb ?? ""}" is not read-only (allowed: ${[...READ_ONLY_VERBS].join(", ")}).`,
    );
  }
}
