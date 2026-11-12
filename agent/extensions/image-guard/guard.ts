import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Part {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}
export interface Resized {
  data: string;
  from: [number, number];
  to: [number, number];
}
/** Downscale one base64 image. Returns undefined when nothing to do. May throw. */
export type Resizer = (
  data: string,
  mimeType: string,
  maxSide: number,
) => Promise<Resized | undefined>;

export const DEFAULT_THRESHOLD = 300_000;
export const MAX_SIDE = 1024;
export const TIMEOUT_MS = 10_000;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const run = (cmd: string, args: string[], timeout: number) =>
  new Promise<string>((res, rej) =>
    execFile(cmd, args, { timeout, killSignal: "SIGKILL", maxBuffer: 1 << 20 }, (e, out) =>
      e ? rej(e) : res(String(out)),
    ),
  );

/** ImageMagick resizer. Work stays in a private dir under os.tmpdir(); removed on every path. */
export function magickResizer(bin = "magick", timeoutMs = TIMEOUT_MS): Resizer {
  return async (data, mimeType, maxSide) => {
    const ext = EXT[mimeType];
    if (!ext) return undefined;
    const dir = await mkdtemp(join(tmpdir(), "image-guard-"));
    try {
      const inp = join(dir, `in.${ext}`);
      const out = join(dir, `out.${ext}`);
      await writeFile(inp, Buffer.from(data, "base64"), { mode: 0o600 });
      const dims = (s: string) => s.trim().split(/\s+/).map(Number) as [number, number];
      const from = dims(await run(bin, ["identify", "-format", "%w %h", `${inp}[0]`], timeoutMs));
      if (Math.max(...from) <= maxSide) return undefined;
      await run(bin, [`${inp}[0]`, "-resize", `${maxSide}x${maxSide}>`, out], timeoutMs);
      const to = dims(await run(bin, ["identify", "-format", "%w %h", out], timeoutMs));
      return { data: (await readFile(out)).toString("base64"), from, to };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

export interface Stats {
  downscaled: number;
  bytesBefore: number;
  bytesAfter: number;
  failures: number;
  lastError?: string;
}

export function createImageGuard(opts: { resize: Resizer; threshold?: number; maxSide?: number }) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxSide = opts.maxSide ?? MAX_SIDE;
  const stats: Stats = { downscaled: 0, bytesBefore: 0, bytesAfter: 0, failures: 0 };

  return {
    stats: () => ({ ...stats }),
    /** Returns new content, or undefined to keep the original. Never throws. */
    async onToolResult(event: { content?: Part[] }): Promise<{ content: Part[] } | undefined> {
      try {
        const parts = event.content;
        if (!Array.isArray(parts)) return;
        if (!parts.some((p) => p?.type === "image" && (p.data?.length ?? 0) > threshold)) return;
        const out: Part[] = [];
        const notes: string[] = [];
        let changed = false;
        for (const p of parts) {
          if (p?.type !== "image" || typeof p.data !== "string" || p.data.length <= threshold) {
            out.push(p);
            continue;
          }
          try {
            const r = await opts.resize(p.data, p.mimeType ?? "", maxSide);
            if (!r || r.data.length >= p.data.length) {
              out.push(p);
              continue;
            }
            out.push({ ...p, data: r.data });
            notes.push(`image downscaled ${r.from[0]}x${r.from[1]} -> ${r.to[0]}x${r.to[1]}`);
            stats.downscaled++;
            stats.bytesBefore += p.data.length;
            stats.bytesAfter += r.data.length;
            changed = true;
          } catch (e) {
            stats.failures++;
            stats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
            out.push(p);
          }
        }
        if (!changed) return;
        return { content: [...out, { type: "text", text: notes.join("; ") }] };
      } catch (e) {
        stats.failures++;
        stats.lastError = String((e as Error)?.message ?? e).slice(0, 200);
        return;
      }
    },
    format(enabled: boolean): string {
      const mb = (n: number) => (n / 1e6).toFixed(2);
      return `image-guard: ${enabled ? "on" : "off (set PI_IMAGE_GUARD=1)"}; threshold ${threshold} B, max side ${maxSide}px; downscaled ${stats.downscaled} (${mb(stats.bytesBefore)} -> ${mb(stats.bytesAfter)} MB), failures ${stats.failures}${stats.lastError ? ` (last: ${stats.lastError})` : ""}`;
    },
  };
}
