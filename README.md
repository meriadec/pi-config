# pi-config

My personal configuration for the [Pi coding agent](https://github.com/badlogic/pi-mono) — a versioned copy of my `~/.pi` directory for backup and syncing across machines.

## Layout

```
agent/
├── settings.json        # Default provider, model, theme, and UI preferences
├── extensions/          # TypeScript extensions that hook into agent events
├── skills/              # Custom agent skills (workflows the agent can invoke)
└── themes/              # Custom color themes
```

## Security

Credentials and session history are never committed. `.gitignore` excludes
`auth.json`, `sessions/`, and `*.session` files.
