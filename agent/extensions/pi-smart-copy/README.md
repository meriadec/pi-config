# pi-smart-copy

Pi extension for copying code blocks from the latest assistant answer.

## Behavior

- `/smart-copy` and `/c` wait for the current agent turn to finish.
- The extension reads the latest assistant message on the current session branch.
- It recognizes only plain, column-0 triple-backtick code blocks:
  - opening fence starts with ` ``` ` and may include language/info text
  - closing fence is exactly ` ``` `
- Copied code-block content is the text between the fence lines, excluding the delimiter newline immediately before the closing fence.
- If there are no code blocks, it copies the full raw assistant answer.
- If there is one code block, it copies it immediately.
- If there are multiple code blocks, it opens a full-screen selector and includes a `Full answer` option.

## Location

This extension lives directly in the Pi agent config repo under:

```text
~/.pi/agent/extensions/pi-smart-copy
```

Pi auto-discovers the folder via `index.ts`. After changing the extension code, run `/reload` inside Pi.

## Development

Run the parser tests directly when changing extraction behavior:

```bash
bun test pi-smart-copy/src/extract.test.ts
```

There is intentionally no package manifest, lockfile, or local install step; this is a personal global Pi extension, not a distributable package.
