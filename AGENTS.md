# pi-config guidance

This repository is the versioned copy of `~/.pi`: personal Pi coding-agent configuration, extensions, skills, prompt templates, and themes.

## Harness

Use the root harness for repo changes:

```bash
bun run typecheck  # tsgo strict typecheck for tracked TypeScript extensions
bun run test       # Bun tests, currently extension parser tests
bun run check      # typecheck + tests
```

The typechecker is `tsgo` from `@typescript/native-preview`, not `tsc`. Keep `tsconfig.json` no-emit and strict; this repo should validate configuration code without producing build artifacts.

When changing only `agent/extensions/pi-smart-copy/src/extract.ts`, a targeted loop is acceptable first:

```bash
bun test agent/extensions/pi-smart-copy/src/extract.test.ts
```

## Repository shape

- `agent/extensions/` — TypeScript Pi extensions auto-discovered by Pi.
- `agent/skills/` — local skills plus symlinks to shared skills under `~/.agents/skills`.
- `agent/prompts/` — prompt templates.
- `agent/themes/` — theme JSON files.
- `agent/settings.json` and `agent/models.json` — versioned agent configuration.

Do not commit credentials, trust decisions, package installs, or sessions. `.gitignore` excludes `agent/auth.json`, `agent/trust.json`, `agent/npm/`, and `agent/sessions/`.

## Extension conventions

- Prefer deep modules: keep each extension command/tool interface small, and hide parsing, state reconstruction, and shell details behind local helpers.
- Import Pi extension types from `@earendil-works/pi-coding-agent`; do not add new imports from older package names.
- Extensions run with full user permissions. Be conservative around filesystem writes, subprocesses, Git operations, credentials, and session data.
- If an extension starts timers, child processes, watchers, sockets, or other long-lived resources, start them from a session-scoped hook/command and clean them up in `session_shutdown`.
- Use `ctx.mode === "tui"` before TUI-only UI such as `ctx.ui.custom()` components.
- Use `ctx.hasUI` before prompting with dialogs/notifications that require a UI-capable mode.
- Custom tools that mutate files must participate in Pi's file mutation queue when relevant.
- Tool output must stay bounded; follow Pi's truncation guidance for any new custom tool that can produce large output.

## Skills and symlinks

Several skill entries are symlinks into `~/.agents/skills`. Preserve symlinks unless intentionally vendoring a skill. If editing a symlinked skill, remember the change belongs to the shared skill source, not just this config repo.

## Runtime workflow

After editing an auto-discovered extension, run the harness, then use `/reload` inside Pi to load the changed extension in an interactive session.

No commits are made by default. Leave version-control decisions to the human unless explicitly instructed otherwise.
