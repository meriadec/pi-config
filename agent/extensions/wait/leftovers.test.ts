import { expect, test } from "bun:test";
import { LeftoverWatch } from "./leftovers.ts";
import type { TaggedProcess } from "./procscan.ts";

const server: TaggedProcess = { pid: 9, ppid: 1, ageSeconds: 120, command: "pnpm dev" };

function watch(found: TaggedProcess[]) {
  const state = { scans: 0, notes: [] as string[] };
  const w = new LeftoverWatch(
    async () => (state.scans++, found),
    (n) => void state.notes.push(n),
  );
  return { w, state };
}

test("no scan runs at agent end when no bash command looked like a background start", async () => {
  const { w, state } = watch([server]);
  w.noteBashCommand("ls -la && git status");
  await w.onAgentEnd();
  expect(state.scans).toBe(0);
  expect(state.notes).toEqual([]);
});

test("a background marker triggers the scan and one note, not a repeat", async () => {
  const { w, state } = watch([server]);
  w.noteBashCommand("pnpm dev > /tmp/log 2>&1 &");
  await w.onAgentEnd();
  expect(state.scans).toBe(1);
  expect(state.notes).toHaveLength(1);
  await w.onAgentEnd();
  expect(state.scans).toBe(2);
  expect(state.notes).toHaveLength(1);
});

test("the scan stops once nothing is left", async () => {
  const { w, state } = watch([]);
  w.noteBashCommand("nohup ./run &");
  await w.onAgentEnd();
  await w.onAgentEnd();
  expect(state.scans).toBe(1);
});
