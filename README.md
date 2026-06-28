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
