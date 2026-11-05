import { MAX_TAIL, compileGrep, keepLastLines, type Capped, type Workload } from "./text.ts";

export const MAX_LINE_CHARS = 500;
export const MAX_LOG_BYTES = 100_000;

export interface LogOptions {
  readonly tail: number;
  readonly since: string;
  readonly grep: string | undefined;
}

export function validateTail(value: string | undefined, fallback: number): number {
  const tail = Number(value ?? fallback);
  if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) {
    throw new Error(`--tail must be an integer from 1 to ${MAX_TAIL}.`);
  }
  return tail;
}

/** kubectl args for every pod of a workload, all containers. With a grep, scan a wider window per pod. */
export function buildLogsArgs(workload: Workload, options: LogOptions): string[] {
  if (workload.selector === "") throw new Error(`No pod selector found for ${workload.name}.`);
  const perPod = options.grep === undefined ? options.tail : MAX_TAIL;
  return [
    "logs",
    "-l",
    workload.selector,
    `--tail=${perPod}`,
    `--since=${options.since}`,
    "--timestamps",
    "--prefix",
    "--all-containers",
    "--max-log-requests=20",
    "--ignore-errors",
  ];
}

function timestampOf(line: string): string {
  return /\d{4}-\d{2}-\d{2}T[\d:.]+Z/.exec(line)?.[0] ?? "";
}

function keepLastBytes(
  lines: readonly string[],
  maxBytes: number,
): { lines: readonly string[]; dropped: number } {
  let total = 0;
  let start = lines.length;
  while (start > 0) {
    const size = Buffer.byteLength(lines[start - 1]!) + 1;
    if (total + size > maxBytes) break;
    total += size;
    start--;
  }
  return { lines: lines.slice(start), dropped: start };
}

/** Merge pods by timestamp, grep, cap lines, per-line length and total bytes. */
export function processLogs(raw: string, options: LogOptions): Capped {
  const regex = compileGrep(options.grep);
  const lines = raw.split("\n").filter((line) => line !== "");
  const sorted = [...lines].sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
  const matched = regex === undefined ? sorted : sorted.filter((line) => regex.test(line));
  if (matched.length === 0) {
    const why = regex === undefined ? "" : ` matching /${options.grep}/i`;
    return { text: "", notice: `no log lines${why} in the last ${options.since}` };
  }
  const capped = keepLastLines(matched, options.tail);
  const shortened = capped.text
    .split("\n")
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line));
  const longLines = capped.text.split("\n").filter((line) => line.length > MAX_LINE_CHARS).length;
  const bytes = keepLastBytes(shortened, MAX_LOG_BYTES);
  const notices = [
    capped.notice,
    longLines > 0 ? `${longLines} line(s) shortened to ${MAX_LINE_CHARS} chars` : undefined,
    bytes.dropped > 0 ? `size cap, ${bytes.dropped} older lines not shown` : undefined,
  ];
  return {
    text: bytes.lines.join("\n"),
    notice: notices.filter((n) => n !== undefined).join("; ") || undefined,
  };
}
