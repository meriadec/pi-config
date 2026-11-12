#!/usr/bin/env bun
/**
 * Rough re-fetch baseline from history: for bash results over the cap, how often does the SAME command run again
 * later in the same session, and how often with no edit or write in between (the suspicious case).
 * `bun analytics/refetch-baseline.ts [capBytes]`. An upper bound: some re-runs are normal.
 */
import { createHash } from "node:crypto";
import { commandFamily } from "../agent/extensions/context-guard/index.ts";
import { openSessions, rows } from "./db.ts";

const cap = Number(process.argv[2] ?? 20_000);
const sha = (s: string) => createHash("sha1").update(s).digest("hex");

const db = await openSessions();
const events = await rows<{
  file: string;
  ts: string;
  kind: string;
  cmd: string | null;
  bytes: string | null;
}>(
  db,
  `with calls as (
     select file, ts, json_extract_string(c, '$.id') id, json_extract_string(c, '$.name') name,
            json_extract_string(c, '$.arguments.command') cmd
     from (select file, ts, unnest(from_json(message->'content', '["json"]')) c
           from messages where message->>'role' = 'assistant' and json_type(message->'content') = 'ARRAY')
     where json_extract_string(c, '$.type') = 'toolCall' and json_extract_string(c, '$.name') in ('bash', 'edit', 'write')),
   res as (
     select file, message->>'toolCallId' id,
       (select coalesce(sum(length(json_extract_string(e, '$.text'))), 0)
        from unnest(from_json(message->'content', '["json"]')) t(e) where json_extract_string(e, '$.type') = 'text') bytes
     from messages where message->>'role' = 'toolResult' and message->>'toolName' = 'bash' and json_type(message->'content') = 'ARRAY')
   select c.file, c.ts::varchar ts, c.name kind, c.cmd, r.bytes::varchar bytes
   from calls c left join res r on r.file = c.file and r.id = c.id
   order by c.file, c.ts`,
);

interface Stat {
  capped: number;
  rerun: number;
  rerunNoEdit: number;
}
const byFamily = new Map<string, Stat>();
let file = "";
let seen = new Map<
  string,
  { family: string; edits: number; counted: boolean; countedNoEdit: boolean }
>();
let edits = 0;
const stat = (f: string) =>
  byFamily.get(f) ?? byFamily.set(f, { capped: 0, rerun: 0, rerunNoEdit: 0 }).get(f)!;

for (const e of events) {
  if (e.file !== file) {
    file = e.file;
    seen = new Map();
    edits = 0;
  }
  if (e.kind !== "bash") {
    edits++;
    continue;
  }
  if (!e.cmd) continue;
  const h = sha(e.cmd);
  const prior = seen.get(h);
  if (prior) {
    if (!prior.counted) {
      stat(prior.family).rerun++;
      prior.counted = true;
    }
    if (!prior.countedNoEdit && prior.edits === edits) {
      stat(prior.family).rerunNoEdit++;
      prior.countedNoEdit = true;
    }
  }
  if (Number(e.bytes ?? 0) > cap && !prior) {
    const family = commandFamily(e.cmd);
    stat(family).capped++;
    seen.set(h, { family, edits, counted: false, countedNoEdit: false });
  }
}

const pct = (a: number, b: number) => (b === 0 ? "-" : `${Math.round((100 * a) / b)}%`);
const all = [...byFamily].reduce(
  (t, [, s]) => ({
    capped: t.capped + s.capped,
    rerun: t.rerun + s.rerun,
    rerunNoEdit: t.rerunNoEdit + s.rerunNoEdit,
  }),
  { capped: 0, rerun: 0, rerunNoEdit: 0 },
);
console.log(
  `cap ${cap} B. All families: ${all.capped} capped results, re-run later ${pct(all.rerun, all.capped)}, re-run with no edit between ${pct(all.rerunNoEdit, all.capped)}`,
);
console.log("\nfamily | capped | re-run | re-run, no edit between");
for (const [f, s] of [...byFamily]
  .filter(([, s]) => s.capped >= 20)
  .sort((a, b) => b[1].capped - a[1].capped)
  .slice(0, 15)) {
  console.log(`${f} | ${s.capped} | ${pct(s.rerun, s.capped)} | ${pct(s.rerunNoEdit, s.capped)}`);
}
