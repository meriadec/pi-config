/** Quiet-success rule: shorten the output of noisy commands that exited 0. */

export const QUIET_MIN_BYTES = 4_000;
const MAX_MATCH_LINES = 40;
const TAIL_LINES = 15;

/** Command families (start of a segment) that the quiet rule must skip. */
export const QUIET_EXCLUDE: string[] = [];

const PNPM_FLAGS = String.raw`(?:(?:--filter|-F|-C|--dir)(?:=|\s+)\S+\s+)*`;
const NOISY: RegExp[] = [
  new RegExp(String.raw`^pnpm\s+${PNPM_FLAGS}(?:run\s+)?(?:lint|typecheck|build|test)(?:\s|$)`),
  new RegExp(String.raw`^pnpm\s+(?:--filter|-F)(?:=|\s+)\S+\s+(?:run\s+)?\S+`),
  /^bun\s+run\s+\S+/,
  /^bun\s+test(?:\s|$)/,
  /^git\s+(?:add|commit)(?:\s|$)/,
  /^(?:npx|bunx)\s+tsc(?:\s|$)/,
  /^tsgo(?:\s|$)/,
];
const TRIVIAL: RegExp[] = [/^tee(?:\s+-a)?\s+\S+$/, /^echo(?:\s|$)/, /^true$/, /^cd(?:\s+\S+)?$/];

function stripPrefixes(segment: string): string {
  let s = segment.trim();
  for (;;) {
    const next = s
      .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "")
      .replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
    if (next === s) return s;
    s = next;
  }
}

/** True when every segment of the command is noisy or trivially quiet. */
export function isNoisyCommand(command: string): boolean {
  const segments = command
    .split(/&&|\|\||;|\|/)
    .map(stripPrefixes)
    .filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  let noisy = false;
  for (const seg of segments) {
    if (QUIET_EXCLUDE.some((f) => seg.startsWith(f))) return false;
    if (NOISY.some((r) => r.test(seg))) noisy = true;
    else if (!TRIVIAL.some((r) => r.test(seg))) return false;
  }
  return noisy;
}

// CSI: ESC [ ... final byte. OSC: ESC ] ... BEL or ESC \.
// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

const SIGNAL = /\b(warn(ing)?|error|fail(ed)?|deprecated)\b/i;
const byteLen = (s: string) => Buffer.byteLength(s, "utf8");

export function quietSuccess(
  command: string,
  text: string,
): { text: string; removedBytes: number } | undefined {
  const bytes = byteLen(text);
  if (bytes < QUIET_MIN_BYTES) return undefined;
  if (!isNoisyCommand(command)) return undefined;
  const lines = stripAnsi(text.replace(/\n+$/, "")).split("\n");
  const keep = new Set<number>();
  let matchLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!SIGNAL.test(lines[i]!)) continue;
    const add = [i - 1, i].filter((j) => j >= 0 && !keep.has(j));
    if (matchLines + add.length > MAX_MATCH_LINES) break;
    for (const j of add) keep.add(j);
    matchLines += add.length;
  }
  for (let i = Math.max(0, lines.length - TAIL_LINES); i < lines.length; i++) keep.add(i);
  const kept = [...keep].sort((a, b) => a - b).map((i) => lines[i]!);
  const marker = `[quiet: kept ${kept.length} of ${lines.length} lines; command exited 0]`;
  const out = [marker, ...kept].join("\n");
  const removedBytes = bytes - byteLen(out);
  if (removedBytes <= 0) return undefined;
  return { text: out, removedBytes };
}
