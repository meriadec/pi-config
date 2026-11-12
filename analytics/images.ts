import { createHash } from "node:crypto";

/** Image analytics. Pure: session JSONL lines in, per-session image records out. */

export interface ImageEvent {
  role: "toolResult" | "user";
  bytes: number; // base64 length
  hash: string;
  path?: string;
  /** Index of the message in the session. */
  idx: number;
  /** Compactions seen before this image. */
  epoch: number;
  width?: number;
  height?: number;
}
export interface SessionImages {
  file: string;
  images: ImageEvent[];
  /** Bytes of all tool results (text + image base64). */
  toolResultBytes: number;
}

/** Read width/height from the image header. Returns undefined for formats we do not parse. */
export function dimensions(b64: string): { width: number; height: number } | undefined {
  let b: Buffer;
  try {
    b = Buffer.from(b64, "base64");
  } catch {
    return undefined;
  }
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47)
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString("latin1", 0, 3) === "GIF")
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined;
      const m = b[i + 1]!;
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return undefined;
  }
  if (
    b.length > 30 &&
    b.toString("latin1", 0, 4) === "RIFF" &&
    b.toString("latin1", 8, 12) === "WEBP"
  ) {
    const k = b.toString("latin1", 12, 16);
    if (k === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (k === "VP8 ")
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (k === "VP8L") {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  return undefined;
}

type Part = { type?: string; text?: string; data?: string };

/** Extract image events from one session's JSONL lines. Lines without images are only measured. */
export function scanSession(file: string, lines: Iterable<string>): SessionImages {
  const images: ImageEvent[] = [];
  const paths = new Map<string, string>();
  let toolResultBytes = 0;
  let epoch = 0;
  let idx = 0;
  for (const line of lines) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "compaction") {
      epoch++;
      continue;
    }
    if (e.type !== "message") continue;
    idx++;
    const m = e.message;
    if (m?.role === "assistant" && Array.isArray(m.content))
      for (const c of m.content)
        if (c?.type === "toolCall" && typeof c.arguments?.path === "string")
          paths.set(c.id, c.arguments.path);
    if (m?.role !== "toolResult" && m?.role !== "user") continue;
    const parts: Part[] = Array.isArray(m.content) ? m.content : [];
    for (const p of parts) {
      const size = p.type === "image" ? (p.data?.length ?? 0) : (p.text?.length ?? 0);
      if (m.role === "toolResult") toolResultBytes += size;
      if (p.type !== "image" || !p.data) continue;
      images.push({
        role: m.role,
        bytes: p.data.length,
        hash: createHash("sha1").update(p.data).digest("hex"),
        path: m.role === "toolResult" ? paths.get(m.toolCallId) : undefined,
        idx,
        epoch,
        ...dimensions(p.data),
      });
    }
    if (typeof m.content === "string" && m.role === "toolResult")
      toolResultBytes += m.content.length;
  }
  return { file, images, toolResultBytes };
}

export const STUB_BYTES = 80;
export const MAX_SIDE = 1024;
export const THRESHOLD = 300_000;

/** Bytes after downscale. Assumption: bytes scale with pixel count. Unknown size or small image: unchanged. */
export function downscaledBytes(i: ImageEvent, threshold = THRESHOLD): number {
  if (i.bytes <= threshold || !i.width || !i.height) return i.bytes;
  const long = Math.max(i.width, i.height);
  if (long <= MAX_SIDE) return i.bytes;
  return Math.round(i.bytes * (MAX_SIDE / long) ** 2);
}

/** Marks images that repeat an earlier copy (same hash) still in context (no compaction between). */
export function repeatsInContext(images: ImageEvent[]): boolean[] {
  const last = new Map<string, number>();
  return images.map((i) => {
    const prev = last.get(i.hash);
    last.set(i.hash, i.epoch);
    return prev !== undefined && prev === i.epoch;
  });
}

export interface ImageStats {
  sessions: number;
  sessionsWithImages: number;
  toolResultImages: { count: number; bytes: number };
  userImages: { count: number; bytes: number };
  sizeBuckets: { label: string; count: number; bytes: number }[];
  p50: number;
  p90: number;
  max: number;
  distinct: number;
  distinctRepeated: number;
  repeatLoads: number;
  inContextRepeats: { count: number; bytes: number };
  totalToolResultBytes: number;
  imageToolBytes: number;
  byLabel: Record<string, { sessions: number; toolResultBytes: number; imageBytes: number }>;
  noDims: number;
  policies: { downscale: number; stub: number; both: number };
}

const BUCKETS: [string, number][] = [
  ["<50KB", 50e3],
  ["50-300KB", 300e3],
  ["300KB-1MB", 1e6],
  ["1-3MB", 3e6],
  [">=3MB", Infinity],
];

const pctile = (xs: number[], p: number) =>
  xs.length ? [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil((p / 100) * xs.length) - 1)]! : 0;

export function analyzeImages(
  sessions: SessionImages[],
  labelOf: (file: string) => string,
  threshold = THRESHOLD,
): ImageStats {
  const s: ImageStats = {
    sessions: sessions.length,
    sessionsWithImages: 0,
    toolResultImages: { count: 0, bytes: 0 },
    userImages: { count: 0, bytes: 0 },
    sizeBuckets: BUCKETS.map(([label]) => ({ label, count: 0, bytes: 0 })),
    p50: 0,
    p90: 0,
    max: 0,
    distinct: 0,
    distinctRepeated: 0,
    repeatLoads: 0,
    inContextRepeats: { count: 0, bytes: 0 },
    totalToolResultBytes: 0,
    imageToolBytes: 0,
    byLabel: {},
    noDims: 0,
    policies: { downscale: 0, stub: 0, both: 0 },
  };
  const sizes: number[] = [];
  for (const ses of sessions) {
    const label = labelOf(ses.file);
    const L = (s.byLabel[label] ??= { sessions: 0, toolResultBytes: 0, imageBytes: 0 });
    L.sessions++;
    L.toolResultBytes += ses.toolResultBytes;
    s.totalToolResultBytes += ses.toolResultBytes;
    if (ses.images.length) s.sessionsWithImages++;
    const counts = new Map<string, number>();
    const rep = repeatsInContext(ses.images);
    ses.images.forEach((i, k) => {
      const bucket = s[i.role === "user" ? "userImages" : "toolResultImages"];
      bucket.count++;
      bucket.bytes += i.bytes;
      sizes.push(i.bytes);
      s.sizeBuckets[BUCKETS.findIndex(([, hi]) => i.bytes < hi)]!.count++;
      s.sizeBuckets[BUCKETS.findIndex(([, hi]) => i.bytes < hi)]!.bytes += i.bytes;
      counts.set(i.hash, (counts.get(i.hash) ?? 0) + 1);
      if (!i.width) s.noDims++;
      if (i.role === "toolResult") {
        s.imageToolBytes += i.bytes;
        L.imageBytes += i.bytes;
        const down = downscaledBytes(i, threshold);
        const stubbed = rep[k]!;
        s.policies.downscale += i.bytes - down;
        s.policies.stub += stubbed ? i.bytes - STUB_BYTES : 0;
        s.policies.both += stubbed ? i.bytes - STUB_BYTES : i.bytes - down;
      }
      if (rep[k]) {
        s.inContextRepeats.count++;
        s.inContextRepeats.bytes += i.bytes;
      }
    });
    for (const n of counts.values()) {
      s.distinct++;
      if (n > 1) {
        s.distinctRepeated++;
        s.repeatLoads += n - 1;
      }
    }
  }
  s.p50 = pctile(sizes, 50);
  s.p90 = pctile(sizes, 90);
  s.max = Math.max(0, ...sizes);
  return s;
}

const mb = (n: number) => (n / 1e6).toFixed(1);
const pc = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "0.0") + "%";

export function formatImages(s: ImageStats): string {
  const tot = s.toolResultImages.bytes + s.userImages.bytes;
  const L = [
    `sessions: ${s.sessions}, with images: ${s.sessionsWithImages}`,
    `tool-result images: ${s.toolResultImages.count} (${mb(s.toolResultImages.bytes)} MB); user-attached: ${s.userImages.count} (${mb(s.userImages.bytes)} MB); total ${mb(tot)} MB`,
    `size per image: p50 ${(s.p50 / 1e3).toFixed(0)} KB, p90 ${(s.p90 / 1e3).toFixed(0)} KB, max ${(s.max / 1e3).toFixed(0)} KB (${s.noDims} without readable dimensions)`,
    ...s.sizeBuckets.map(
      (b) =>
        `  ${b.label.padEnd(10)} ${String(b.count).padStart(6)}  ${mb(b.bytes).padStart(7)} MB`,
    ),
    `distinct images (by content hash, per session): ${s.distinct}; loaded more than once: ${s.distinctRepeated} (${s.repeatLoads} extra loads)`,
    `loads with an earlier copy still in context (no compaction between): ${s.inContextRepeats.count} (${mb(s.inContextRepeats.bytes)} MB)`,
    `images are ${pc(s.imageToolBytes, s.totalToolResultBytes)} of all tool-result bytes (${mb(s.imageToolBytes)} of ${mb(s.totalToolResultBytes)} MB)`,
    "by label (image share of tool-result bytes):",
  ];
  for (const [k, v] of Object.entries(s.byLabel).sort((a, b) => b[1].imageBytes - a[1].imageBytes))
    L.push(
      `  ${k.padEnd(20)} ${String(v.sessions).padStart(5)} sessions  ${mb(v.imageBytes).padStart(7)} / ${mb(v.toolResultBytes).padStart(7)} MB  ${pc(v.imageBytes, v.toolResultBytes)}`,
    );
  L.push(
    `estimated savings on tool-result image bytes (${mb(s.imageToolBytes)} MB):`,
    `  (a) downscale to ${MAX_SIDE}px long side, only images > ${THRESHOLD / 1000} KB: ${mb(s.policies.downscale)} MB (${pc(s.policies.downscale, s.imageToolBytes)})`,
    `  (b) stub repeat reads (hash seen in context): ${mb(s.policies.stub)} MB (${pc(s.policies.stub, s.imageToolBytes)})`,
    `  (c) both (repeat = stub, first load = downscale): ${mb(s.policies.both)} MB (${pc(s.policies.both, s.imageToolBytes)})`,
    "assumption: bytes scale with pixel count, so new = old * (1024/long)^2; format and compression stay equal.",
  );
  return L.join("\n");
}
