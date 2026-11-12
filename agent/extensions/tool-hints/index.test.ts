import { expect, test } from "bun:test";
import toolHints from "./index.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => Promise<unknown>;
const load = () => {
  let handler: Handler | undefined;
  toolHints({ on: (_n: string, h: Handler) => (handler = h) } as never);
  return handler!;
};
const ev = (over: Record<string, unknown>) => ({
  toolName: "read",
  input: { path: "/tmp/definitely-missing-dir-xyz/a.png" },
  content: [{ type: "text", text: "File not found: x" }],
  isError: true,
  ...over,
});

test("appends a hint to a failing read and keeps the original text", async () => {
  const out = (await load()(ev({}), { cwd: "/tmp" })) as { content: { text: string }[] };
  expect(out.content[0]!.text).toBe("File not found: x");
  expect(out.content[1]!.text).toContain("Hint:");
});

test("does not touch a successful result", async () => {
  expect(await load()(ev({ isError: false }), { cwd: "/tmp" })).toBeUndefined();
});

test("fails open on odd input", async () => {
  expect(await load()(ev({ input: null, content: "oops" }), { cwd: "/tmp" })).toBeUndefined();
});

test("edit stale error after a read of other anchors gets a hint", async () => {
  const h = load();
  await h(
    ev({
      toolName: "read",
      isError: false,
      input: { path: "/w/a.ts" },
      content: [{ type: "text", text: "1#ZP:x" }],
    }),
    { cwd: "/w" },
  );
  const out = (await h(
    ev({
      toolName: "edit",
      input: { path: "/w/a.ts" },
      content: [{ type: "text", text: "[E_STALE_ANCHOR] 1 stale anchor: 99#MQ. Re-read." }],
    }),
    { cwd: "/w" },
  )) as { content: { text: string }[] };
  expect(out.content[1]!.text).toContain("99#MQ");
});
