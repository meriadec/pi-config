import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createImageGuard, magickResizer, type Resizer } from "./guard.ts";

const big = "A".repeat(400_000);
const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });
const fake: Resizer = async () => ({ data: "small", from: [3000, 2000], to: [1024, 683] });

test("downscales a large image and adds a one-line note", async () => {
  const g = createImageGuard({ resize: fake });
  const r = await g.onToolResult({ content: [{ type: "text", text: "Read image" }, img(big)] });
  expect(r?.content).toEqual([
    { type: "text", text: "Read image" },
    { ...img("small") },
    { type: "text", text: "image downscaled 3000x2000 -> 1024x683" },
  ]);
  expect(g.stats().downscaled).toBe(1);
});

test("image under the threshold is untouched and the resizer is not called", async () => {
  let calls = 0;
  const g = createImageGuard({ resize: async () => (calls++, undefined) });
  expect(await g.onToolResult({ content: [img("A".repeat(299_999))] })).toBeUndefined();
  expect(calls).toBe(0);
});

test("threshold is configurable", async () => {
  const g = createImageGuard({ resize: fake, threshold: 10 });
  expect(await g.onToolResult({ content: [img("A".repeat(11))] })).toBeDefined();
});

test("fails open when the resizer throws", async () => {
  const g = createImageGuard({
    resize: async () => {
      throw new Error("boom");
    },
  });
  expect(await g.onToolResult({ content: [img(big)] })).toBeUndefined();
  expect(g.stats().failures).toBe(1);
});

test("one failing image keeps the original part while another is downscaled", async () => {
  let n = 0;
  const g = createImageGuard({
    resize: async () => {
      if (n++ === 0) throw new Error("x");
      return { data: "s", from: [2000, 2000], to: [1024, 1024] };
    },
  });
  const r = await g.onToolResult({ content: [img(big), img(big)] });
  expect(r?.content[0]).toEqual(img(big));
  expect(r?.content[1]).toEqual(img("s"));
});

test("keeps the original when the output is not smaller", async () => {
  const g = createImageGuard({
    resize: async () => ({ data: big + "A", from: [2000, 2000], to: [1024, 1024] }),
  });
  expect(await g.onToolResult({ content: [img(big)] })).toBeUndefined();
});

test("malformed event does not throw", async () => {
  const g = createImageGuard({ resize: fake });
  expect(await g.onToolResult({} as never)).toBeUndefined();
  expect(await g.onToolResult({ content: [null as never, img(big)] })).toBeDefined();
});

const hasMagick = Bun.which("magick") !== null;
const png = async (w: number, h: number) => {
  const p = Bun.spawn(["magick", "-size", `${w}x${h}`, "plasma:fractal", "png:-"], {
    stdout: "pipe",
  });
  return Buffer.from(await new Response(p.stdout).arrayBuffer()).toString("base64");
};
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("image-guard-"));

test.skipIf(!hasMagick)(
  "real ImageMagick: downscales to 1024 long side and cleans temp files",
  async () => {
    const before = leftovers().length;
    const g = createImageGuard({ resize: magickResizer(), threshold: 1000 });
    const data = await png(2000, 1000);
    const r = await g.onToolResult({ content: [img(data)] });
    expect(r?.content.at(-1)?.text).toBe("image downscaled 2000x1000 -> 1024x512");
    expect(r!.content[0]!.data!.length).toBeLessThan(data.length);
    expect(leftovers().length).toBe(before);
  },
);

test.skipIf(!hasMagick)(
  "real ImageMagick: image already within 1024 px is kept; bad data fails open and cleans up",
  async () => {
    const before = leftovers().length;
    const g = createImageGuard({ resize: magickResizer(), threshold: 10 });
    expect(await g.onToolResult({ content: [img(await png(500, 400))] })).toBeUndefined();
    expect(await g.onToolResult({ content: [img("A".repeat(100))] })).toBeUndefined();
    expect(g.stats().failures).toBe(1);
    expect(leftovers().length).toBe(before);
  },
);

test("timeout fails open", async () => {
  const g = createImageGuard({ resize: magickResizer("sleep", 100), threshold: 10 });
  const t = Date.now();
  expect(await g.onToolResult({ content: [img("A".repeat(100))] })).toBeUndefined();
  expect(Date.now() - t).toBeLessThan(3000);
  expect(g.stats().failures).toBe(1);
});
