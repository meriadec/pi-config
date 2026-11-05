export type FlagKind = "string" | "boolean";
export type FlagSpec = Readonly<Record<string, FlagKind>>;

export interface Parsed {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
}

/** Strict parser: `--flag value`, `--flag=value`, booleans. Unknown flags are errors. */
export function parseArgs(command: string, argv: readonly string[], spec: FlagSpec): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const kind = spec[key];
    if (kind === undefined) {
      const allowed =
        Object.keys(spec)
          .map((name) => `--${name}`)
          .join(", ") || "none";
      throw new Error(`Unknown flag --${key} for "${command}". Allowed: ${allowed}.`);
    }
    if (kind === "boolean") {
      flags.set(key, "true");
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`Flag --${key} needs a value.`);
    flags.set(key, value);
  }
  return { positional, flags };
}
