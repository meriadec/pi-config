# pi-config

Versioned backup of my `~/.pi` directory for the [Pi coding agent](https://github.com/badlogic/pi-mono).

The repo should document durable local conventions, not mirror information that can be discovered from the filesystem or Pi itself.

## Layout

```text
agent/
├── extensions/          # Pi TypeScript extensions
├── skills/              # Local skills plus symlinks to shared skills
├── prompts/             # Prompt templates
├── themes/              # Theme JSON files
├── settings.json        # Versioned agent settings
└── models.json          # Versioned model/provider definitions
```

Runtime state and credentials are intentionally ignored. See `.gitignore` for the exact denylist.

The Work control-plane package is developed in the separate `~/git/pi-work` repository. `agent/settings.json` loads that active checkout through the relative package path `../../git/pi-work`.

## Waits and analytics

- `agent/extensions/wait/` adds `wait_for`, `wait_list` and `wait_cancel`. PR and long-timer waits use T3 (`watch_pull_request`, `schedule_task`). Process, URL and short-timer waits run in-process and wake the session with a follow-up message. At the end of a turn the extension lists leftover processes the session started. Local waits end with the session.
- `analytics/` loads `agent/sessions` into DuckDB: `bun analytics/cli.ts <errors|context|polling>`.
- Skills audit: `bun analytics/skills-report.ts` prints per-skill size, sessions, first/last use, errors, cost and never-used skills. Findings and decisions: `docs/skills-audit.md`.
- `experiments/waits/` holds the mock comparison and the display mock.

## Context guard

- `agent/extensions/context-guard/` reduces large `bash` results. Env `PI_CONTEXT_GUARD` selects the mode: `shadow` (default: change nothing, only log), `live` (cut to a 20 KB head+tail and write the full output to `/tmp/pi-out/`, 0600, deleted after 7 days) or `off`.
- Shadow records go to `analytics/data/context-guard.jsonl` (git-ignored). They hold only the two-word command family, the command sha1, sizes and the rule (`cap` or `refetch`). No command text and no output text.
- Report: `bun analytics/guard-report.ts` prints records per rule, would-remove MB, the top 10 families and the re-fetch rate per family.

- Reread rule (`reread.ts`): if a file of 1.5 KB or more is read again with the same path, mtime, size and offset/limit, and no compaction happened, the earlier result is still in context. `shadow` logs `rule: "reread"` with the extension only (or the basename for AGENTS.md, CONTEXT.md, GLOSSARY.md, SKILL.md, README.md, package.json). `live` blocks the call once; a repeat right after the block goes through. Images are skipped.

- Quiet rule (`quiet.ts`): for a noisy bash command that succeeded (`isError === false`), it keeps the warning/error lines with 1 line of context, the last 15 lines and a marker line, and it strips ANSI. Noisy: `pnpm lint|typecheck|build|test`, `bun run`, `bun test`, `git add|commit`, `tsc`, `tsgo`. It never changes a failing result. It runs before the cap rule, in the same mode (`shadow` logs `rule: "quiet"`, `live` shortens).

## Delegation guard

- `agent/extensions/delegation-guard/` watches `delegate_task`, `t3_thread_launch` and `create_threads` (T3 Code). Env `PI_DELEGATION_GUARD`: `shadow` (default: only log), `live` (apply the rules) or `off`. `PI_DELEGATION_MAX` sets the child cap (default 6).
- Log: `analytics/data/delegation.jsonl` (git-ignored). Each record has the tool, role, mode, isolation, model, task byte length, task sha1, and sha1 of task/thread ids. No task text. `task_status`, `task_cancel` and thread tools are linked to the earlier delegation by id hash.
- Rules: `child-cap` (more than the cap started in one session), `duplicate` (same task sha1 after `fetch failed`, or with no result yet, and no `clientRequestId`: retry with one), `unchecked-async` (log only, never a message: T3 wakes the parent when an async child ends, so an unchecked child is not lost). In `shadow` mode each rule only logs `would_block`.
- Report: `bun analytics/delegation-report.ts`. Part 1 reads all past sessions: calls, per model/role/mode, error rate and classes, orphan candidates, retry duplicates, peak children per session. Part 2 reads the live log: same counts plus `would_block` per rule.
- History (2026-11): 323 delegations in 57 sessions, 12 errors (8 `fetch failed`), 203 unchecked async children (not necessarily lost), 2 retry duplicates, peak 37 children in one session.

## Tool hints

- `agent/extensions/tool-hints/` adds one short hint (400 bytes at most) to a failing `read` (path not found: similar names, nearest existing directory, parallel-call note for images) or `edit` (hashline anchor error: never shown, edited since read, malformed). It only adds text to results that already failed, and it fails open. Causes and counts: `docs/tooling-errors.md`. Replay on history: `bun analytics/tool-hints-replay.ts`.

## Harness

Use Bun for scripts and `tsgo` for typechecking:

```bash
bun install
bun run check
```

Available scripts:

```bash
bun run typecheck  # strict no-emit tsgo check
bun run test       # Bun tests under agent/extensions
bun run check      # typecheck + tests
```

`tsconfig.json` is intentionally strict and no-emit because Pi loads TypeScript extensions directly.

## Extension workflow

After changing an auto-discovered extension:

1. Run the narrowest useful harness, usually `bun run check` before handoff.
2. Use `/reload` in a running Pi session.
3. Manually exercise changed interactive behavior when typechecks/tests cannot cover it.

Prefer putting pure parsing/formatting logic behind small local modules with Bun tests. Keep Pi-facing seams narrow: commands, tools, event handlers, and user-visible configuration should stay simple while implementation details remain local.

## Security

Do not commit credentials, trust decisions, sessions, package installs, or generated artifacts.

Extensions run with full local user permissions. Review filesystem, subprocess, network, Git, and credential handling carefully before enabling new behavior globally.
