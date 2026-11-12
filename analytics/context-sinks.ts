#!/usr/bin/env bun
/** Context sinks by TEXT bytes (images excluded: their base64 is not text tokens) and cap savings. `bun analytics/context-sinks.ts` */
import { openSessions, rows } from "./db.ts";
const db = await openSessions();
const q = async (t: string, s: string) => {
  console.log("\n" + t);
  for (const r of await rows<any>(db, s)) console.log(Object.values(r).join(" | "));
};
await db.run(`create table tr as select file, message->>'toolName' tool, message->>'toolCallId' id, ts,
  (select coalesce(sum(length(json_extract_string(e,'$.text'))),0) from unnest(from_json(message->'content','["json"]')) t(e) where json_extract_string(e,'$.type')='text') tbytes,
  (select count(*) from unnest(from_json(message->'content','["json"]')) t(e) where json_extract_string(e,'$.type')='image') images
  from messages where message->>'role'='toolResult' and json_type(message->'content')='ARRAY'`);
await q(
  "by tool: calls, TEXT MB, avg text bytes, text results >20KB, image results",
  `select tool, count(*), round(sum(tbytes)/1e6), round(avg(tbytes)), count(*) filter (where tbytes>20000), count(*) filter (where images>0) from tr group by 1 order by 3 desc limit 6`,
);
await db.run(`create table calls as select file, json_extract_string(c,'$.id') id, json_extract_string(c,'$.name') name, json_extract_string(c,'$.arguments.path') path, json_extract_string(c,'$.arguments.command') cmd
  from (select file, unnest(from_json(message->'content','["json"]')) c from messages where message->>'role'='assistant' and json_type(message->'content')='ARRAY') where json_extract_string(c,'$.type')='toolCall'`);
await q(
  "top read paths by total text bytes: path, reads, MB",
  `select c.path, count(*), round(sum(t.tbytes)/1e6,1) mb from tr t join calls c on c.file=t.file and c.id=t.id where t.tool='read' group by 1 order by 3 desc limit 12`,
);
await q(
  "bash: top first-words by text MB",
  `select regexp_extract(c.cmd,'^\\s*([A-Za-z0-9_./-]+)',1) w, count(*), round(sum(t.tbytes)/1e6,1) from tr t join calls c on c.file=t.file and c.id=t.id where t.tool='bash' group by 1 order by 3 desc limit 10`,
);
for (const cap of [10000, 20000, 30000]) {
  await q(
    `cap ${cap}B: bytes removed (MB) and results affected, by tool`,
    `select tool, round(sum(greatest(tbytes-${cap},0))/1e6) removed_mb, count(*) filter (where tbytes>${cap}) affected from tr where tool in ('bash','read') group by 1`,
  );
}
await q(
  "bash >20KB: top commands by count",
  `select regexp_extract(c.cmd,'^\\s*(?:cd [^;&]*(?:;|&&)\\s*)?([A-Za-z0-9_./-]+(?: [a-z-]+)?)',1) w, count(*), round(sum(t.tbytes)/1e6) from tr t join calls c on c.file=t.file and c.id=t.id where t.tool='bash' and t.tbytes>20000 group by 1 order by 3 desc limit 8`,
);
