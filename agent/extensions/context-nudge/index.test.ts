import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nudge from "./index.ts";
import { bandOf } from "./nudge.ts";

let log: string;
beforeEach(() => {
  log = join(mkdtempSync(join(tmpdir(), "nudge-")), "n.jsonl");
  process.env["PI_CONTEXT_NUDGE_LOG"] = log;
  delete process.env["PI_CONTEXT_NUDGE"];
  delete process.env["PI_CONTEXT_NUDGE_TOKENS"];
});
afterEach(() => {
  for (const k of ["PI_CONTEXT_NUDGE_LOG", "PI_CONTEXT_NUDGE", "PI_CONTEXT_NUDGE_TOKENS"])
    delete process.env[k];
});

function setup(opts: { hasUI?: boolean } = {}) {
  const handlers: Record<string, (e: any, c: any) => Promise<unknown>> = {};
  const commands: Record<string, any> = {};
  nudge({
    on: (n: string, h: any) => (handlers[n] = h),
    registerCommand: (n: string, c: any) => (commands[n] = c),
  } as never);
  const notes: string[] = [];
  const branch = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.5 } } } },
    { type: "message", message: { role: "assistant", usage: { cost: { total: 0.25 } } } },
  ];
  const state = { tokens: 0 as number | undefined };
  const ctx = {
    hasUI: opts.hasUI ?? true,
    model: { id: "m1" },
    getContextUsage: () => (state.tokens === undefined ? undefined : { tokens: state.tokens }),
    sessionManager: { getSessionFile: () => "/s/a.jsonl", getBranch: () => branch },
    ui: { notify: (m: string) => notes.push(m) },
  };
  const turn = (tokens: number | undefined) => {
    state.tokens = tokens;
    return handlers["turn_end"]!({}, ctx);
  };
  return { handlers, commands, ctx, turn, notes, branch };
}
const lines = () =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

test("bandOf", () => {
  expect(bandOf(149_999, 150_000)).toBe(-1);
  expect(bandOf(150_000, 150_000)).toBe(0);
  expect(bandOf(250_000, 150_000)).toBe(1);
});

test("logs once at threshold and once per further 100K", async () => {
  const s = setup();
  for (const t of [100_000, 160_000, 170_000, 240_000, 260_000, 262_000, 370_000]) await s.turn(t);
  const l = lines();
  expect(l.map((x) => x.tokens)).toEqual([160_000, 260_000, 370_000]);
  expect(l[0]).toMatchObject({
    session: "/s/a.jsonl",
    model: "m1",
    turns: 2,
    cost: 0.75,
    mode: "shadow",
  });
  expect(l[0].wouldDo).toContain("/compact");
});

test("env threshold is honored and a new session logs again", async () => {
  process.env["PI_CONTEXT_NUDGE_TOKENS"] = "50000";
  const s = setup();
  await s.turn(60_000);
  await s.handlers["session_shutdown"]!({}, s.ctx);
  await s.handlers["session_start"]!({}, s.ctx);
  await s.turn(60_000);
  expect(lines()).toHaveLength(2);
});

test("off mode logs nothing", async () => {
  process.env["PI_CONTEXT_NUDGE"] = "off";
  const s = setup();
  await s.turn(900_000);
  expect(lines()).toHaveLength(0);
  expect(s.notes).toHaveLength(0);
});

test("shadow mode never notifies", async () => {
  const s = setup();
  await s.turn(400_000);
  expect(s.notes).toHaveLength(0);
});

test("notify mode notifies once, returns nothing, leaves messages alone", async () => {
  process.env["PI_CONTEXT_NUDGE"] = "notify";
  const s = setup();
  const before = JSON.stringify(s.branch);
  const r1 = await s.turn(160_000);
  const r2 = await s.turn(300_000);
  expect(r1).toBeUndefined();
  expect(r2).toBeUndefined();
  expect(s.notes).toHaveLength(1);
  expect(s.notes[0]).toContain("/compact");
  expect(JSON.stringify(s.branch)).toBe(before);
  expect(lines()).toHaveLength(2);
});

test("notify without UI does not notify but still logs", async () => {
  process.env["PI_CONTEXT_NUDGE"] = "notify";
  const s = setup({ hasUI: false });
  await s.turn(160_000);
  expect(s.notes).toHaveLength(0);
  expect(lines()).toHaveLength(1);
});

test("errors do not throw", async () => {
  const s = setup();
  s.ctx.getContextUsage = () => {
    throw new Error("boom");
  };
  await s.turn(1);
  process.env["PI_CONTEXT_NUDGE_LOG"] = "/proc/nope/x.jsonl";
  const s2 = setup();
  await s2.turn(500_000);
  expect(s2.notes).toHaveLength(0);
});

test("unknown usage tokens logs nothing", async () => {
  const s = setup();
  await s.turn(undefined);
  expect(lines()).toHaveLength(0);
});

test("command prints mode, threshold and this session's lines only", async () => {
  const s = setup();
  await s.turn(200_000);
  await Bun.write(
    log,
    readFileSync(log, "utf8") + JSON.stringify({ session: "other", tokens: 1 }) + "\n",
  );
  await s.commands["context-nudge"].handler("", s.ctx);
  const out = s.notes[0]!;
  expect(out).toContain("mode: shadow");
  expect(out).toContain("threshold: 150000");
  expect(out).toContain("log lines for this session: 1");
  expect(out).not.toContain("other");
});
