export const DEFAULT_CAP_BYTES = 20_000;

const HEAD_SHARE = 0.6;
const NEWLINE = 0x0a;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

// Move a cut point back so it does not split a UTF-8 character.
function backToBoundary(buf: Buffer, cut: number): number {
  let i = cut;
  while (i > 0 && i < buf.length && (buf[i]! & 0xc0) === 0x80) i--;
  return i;
}

// Move a cut point forward so it does not split a UTF-8 character.
function forwardToBoundary(buf: Buffer, cut: number): number {
  let i = cut;
  while (i < buf.length && (buf[i]! & 0xc0) === 0x80) i++;
  return i;
}

function headEnd(buf: Buffer, budget: number): number {
  const nl = buf.subarray(0, budget).lastIndexOf(NEWLINE);
  if (nl >= 0) return nl + 1;
  return backToBoundary(buf, budget);
}

function tailStart(buf: Buffer, budget: number): number {
  const start = buf.length - budget;
  if (start <= 0 || buf[start - 1] === NEWLINE) return Math.max(start, 0);
  const nl = buf.indexOf(NEWLINE, start);
  if (nl >= 0 && nl + 1 < buf.length) return nl + 1;
  return forwardToBoundary(buf, start);
}

/**
 * Keep about 60% head and 40% tail of `capBytes`, cut on line boundaries,
 * and put a marker line between them. Text at or under the cap is unchanged.
 */
export function reduceOutput(
  text: string,
  capBytes: number = DEFAULT_CAP_BYTES,
  fullOutputPath = "unavailable",
): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= capBytes) return text;
  const headBudget = Math.floor(capBytes * HEAD_SHARE);
  const tailBudget = capBytes - headBudget;
  const end = headEnd(buf, headBudget);
  const start = Math.max(tailStart(buf, tailBudget), end);
  const removed = start - end;
  const head = buf.subarray(0, end).toString("utf8");
  const tail = buf.subarray(start).toString("utf8");
  const marker = `[truncated ${removed} bytes; full output: ${fullOutputPath}]`;
  const sep = head.length === 0 || head.endsWith("\n") ? "" : "\n";
  return `${head}${sep}${marker}\n${tail}`;
}

export function removedBytes(text: string, capBytes: number): number {
  const total = byteLength(text);
  if (total <= capBytes) return 0;
  const buf = Buffer.from(text, "utf8");
  const end = headEnd(buf, Math.floor(capBytes * HEAD_SHARE));
  const start = Math.max(tailStart(buf, capBytes - Math.floor(capBytes * HEAD_SHARE)), end);
  return start - end;
}
