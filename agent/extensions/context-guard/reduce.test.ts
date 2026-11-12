import { expect, test } from "bun:test";
import { byteLength, reduceOutput, removedBytes } from "./reduce.ts";

const lines = (n: number, w = 9) =>
  Array.from({ length: n }, (_, i) => String(i).padStart(w, "0")).join("\n");

test("text exactly at the cap is unchanged", () => {
  const t = "a".repeat(100);
  expect(reduceOutput(t, 100)).toBe(t);
  expect(removedBytes(t, 100)).toBe(0);
});

test("text one byte over the cap is reduced with a marker", () => {
  const t = lines(30); // 299 bytes
  const out = reduceOutput(t + "x", 100, "/tmp/pi-out/a.txt");
  expect(out).toContain("[truncated ");
  expect(out).toContain("full output: /tmp/pi-out/a.txt]");
  expect(out.startsWith("000000000\n")).toBe(true);
  expect(out.endsWith("000000029x")).toBe(true);
});

test("marker reports exact removed bytes and kept parts are whole lines", () => {
  const t = lines(100); // 999 bytes
  const out = reduceOutput(t, 200, "P");
  const m = /\[truncated (\d+) bytes; full output: P\]/.exec(out)!;
  const [head, tail] = out.split(m[0]) as [string, string];
  expect(byteLength(head) + byteLength(tail.slice(1)) + Number(m[1])).toBe(byteLength(t));
  expect(Number(m[1])).toBe(removedBytes(t, 200));
  expect(head.endsWith("\n")).toBe(true);
  for (const l of head.trim().split("\n")) expect(l).toMatch(/^\d{9}$/);
  for (const l of tail.trim().split("\n")) expect(l).toMatch(/^\d{9}$/);
  expect(byteLength(head)).toBeLessThanOrEqual(120);
  expect(byteLength(tail)).toBeLessThanOrEqual(81);
  expect(byteLength(head)).toBeGreaterThan(byteLength(tail) - 1);
});

test("counts bytes in UTF-8, not characters", () => {
  const t = "é".repeat(60); // 60 chars, 120 bytes
  expect(reduceOutput(t, 100)).not.toBe(t);
  expect(reduceOutput(t, 120)).toBe(t);
});

test("multibyte text without newline is cut on character boundaries", () => {
  const t = "日本語".repeat(50); // 450 bytes
  const out = reduceOutput(t, 100, "P");
  expect(out).not.toContain("\uFFFD");
  expect(out).toContain("[truncated ");
});

test("text without newline still keeps head and tail", () => {
  const t = "a".repeat(500) + "b".repeat(500);
  const out = reduceOutput(t, 100, "P");
  expect(out.startsWith("a".repeat(60))).toBe(true);
  expect(out.endsWith("b".repeat(40))).toBe(true);
  expect(out).toContain("[truncated 900 bytes");
});
