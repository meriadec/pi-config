import type { DuckDBConnection } from "@duckdb/node-api";
import { rows } from "./db.ts";
import type { SessionFeatures } from "./label.ts";

export interface SessionRow extends SessionFeatures {
  file: string;
  turns: number;
  startedAt: string;
}

/** One row per session: first user message (skill block stripped), first skill, and tool-shape counts. */
export async function sessionFeatures(db: DuckDBConnection): Promise<SessionRow[]> {
  const raw = await rows<{
    file: string;
    first: string | null;
    edits: string;
    bash: string;
    reads: string;
    turns: string;
    started: string;
  }>(
    db,
    `with first_user as (
       select file, message->'content' as c,
         row_number() over (partition by file order by ts) as rn
       from messages where message->>'role' = 'user'),
     fu as (
       select file,
         case when json_type(c) = 'ARRAY' then coalesce(c->>'$[0].text', '') else trim(both '"' from c::varchar) end as text
       from first_user where rn = 1),
     shape as (
       select file, count(*) filter (where tool in ('edit','write')) as edits,
         count(*) filter (where tool = 'bash') as bash, count(*) filter (where tool = 'read') as reads
       from tool_calls group by 1),
     turns as (select file, count(*) as turns, min(ts) as started from messages group by 1)
     select t.file, fu.text as first, coalesce(s.edits,0) as edits, coalesce(s.bash,0) as bash,
       coalesce(s.reads,0) as reads, t.turns, t.started
     from turns t left join fu using (file) left join shape s using (file)`,
  );
  return raw.map((r) => {
    const text = r.first ?? "";
    const skill = /^<skill name="([^"]+)"/.exec(text)?.[1] ?? null;
    return {
      file: r.file,
      project: r.file.split("/").at(-2) ?? "",
      firstSkill: skill,
      firstText: text.replace(/^<skill [^>]*>[\s\S]*?<\/skill>\s*/, "").slice(0, 2000),
      edits: Number(r.edits),
      bash: Number(r.bash),
      reads: Number(r.reads),
      turns: Number(r.turns),
      startedAt: r.started,
    };
  });
}
