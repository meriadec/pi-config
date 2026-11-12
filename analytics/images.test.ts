import { expect, test } from "bun:test";
import {
  analyzeImages,
  dimensions,
  downscaledBytes,
  scanSession,
  STUB_BYTES,
  type ImageEvent,
} from "./images.ts";

const png = (w: number, h: number, pad = 0) => {
  const b = Buffer.alloc(32 + pad);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
};
const msg = (m: object) => JSON.stringify({ type: "message", message: m });
const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });

test("dimensions reads PNG header", () => {
  expect(dimensions(png(3000, 2000))).toEqual({ width: 3000, height: 2000 });
});

test("scan finds tool-result and user images, with path and compaction epoch", () => {
  const a = png(2048, 1024, 100);
  const lines = [
    msg({
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.png" } }],
    }),
    msg({
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "hello" }, img(a)],
    }),
    JSON.stringify({ type: "compaction" }),
    msg({ role: "user", content: [img(a)] }),
  ];
  const s = scanSession("f", lines);
  expect(s.images.map((i) => [i.role, i.path, i.epoch, i.width])).toEqual([
    ["toolResult", "/x.png", 0, 2048],
    ["user", undefined, 1, 2048],
  ]);
  expect(s.toolResultBytes).toBe(5 + a.length);
});

const ev = (hash: string, epoch: number, bytes: number, w = 3000, h = 1000): ImageEvent => ({
  role: "toolResult",
  bytes,
  hash,
  idx: 0,
  epoch,
  width: w,
  height: h,
});
const label = () => "x";

test("downscale scales bytes by pixel count and skips small images", () => {
  expect(downscaledBytes(ev("a", 0, 1_000_000, 2048, 1024))).toBe(250_000);
  expect(downscaledBytes(ev("a", 0, 100_000, 2048, 1024))).toBe(100_000);
  expect(downscaledBytes(ev("a", 0, 1_000_000, 800, 600))).toBe(1_000_000);
});

test("repeat in context counts; repeat after compaction does not; policies add up", () => {
  const imgs = [
    ev("a", 0, 1_000_000),
    ev("a", 0, 1_000_000),
    ev("a", 1, 1_000_000),
    ev("b", 1, 10),
  ];
  const s = analyzeImages([{ file: "f", images: imgs, toolResultBytes: 4_000_010 }], label);
  expect(s.distinct).toBe(2);
  expect(s.distinctRepeated).toBe(1);
  expect(s.repeatLoads).toBe(2);
  expect(s.inContextRepeats).toEqual({ count: 1, bytes: 1_000_000 });
  const down = 1_000_000 - Math.round(1_000_000 * (1024 / 3000) ** 2);
  expect(s.policies.downscale).toBe(3 * down);
  expect(s.policies.stub).toBe(1_000_000 - STUB_BYTES);
  expect(s.policies.both).toBe(2 * down + 1_000_000 - STUB_BYTES);
  expect(s.byLabel["x"]).toEqual({
    sessions: 1,
    toolResultBytes: 4_000_010,
    imageBytes: 3_000_010,
  });
});
