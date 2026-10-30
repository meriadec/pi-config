import { afterEach, expect, test } from "bun:test";
import { createTranscriber, type Transcriber } from "./transcriber.ts";

// Fake worker speaking the same line protocol as daemon.py.
const FAKE = `
console.log(JSON.stringify({ ready: true }));
for await (const line of require("readline").createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  console.log("noise that is not json");
  console.log(JSON.stringify(req.wav.endsWith("bad") ? { id: req.id, error: "boom" } : { id: req.id, text: "heard " + req.wav }));
}`;

let t: Transcriber | undefined;
afterEach(() => t?.close());

test("matches replies to requests by id and ignores non-protocol output", async () => {
  t = createTranscriber("bun", ["-e", FAKE]);
  const [a, b] = await Promise.all([t.transcribe("/a"), t.transcribe("/b")]);
  expect([a, b]).toEqual(["heard /a", "heard /b"]);
});

test("rejects a request when the worker reports an error", async () => {
  t = createTranscriber("bun", ["-e", FAKE]);
  await expect(t.transcribe("/bad")).rejects.toThrow("boom");
});

test("reports worker startup failure with its stderr", async () => {
  t = createTranscriber("bun", ["-e", "console.error('no model'); process.exit(3)"]);
  await expect(t.transcribe("/a")).rejects.toThrow("no model");
});
