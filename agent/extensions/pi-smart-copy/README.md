# pi-smart-copy

Pi extension for copying code blocks from the latest assistant answer.

## Behavior

- `/smart-copy` and `/c` wait for the current agent turn to finish.
- The extension reads the latest assistant message on the current session branch.
- It recognizes only plain, column-0 triple-backtick code blocks:
  - opening fence starts with ```` ``` ```` and may include language/info text
  - closing fence is exactly ```` ``` ````
- Copied code-block content is the text between the fence lines, excluding the delimiter newline immediately before the closing fence.
- If there are no code blocks, it copies the full raw assistant answer.
- If there is one code block, it copies it immediately.
- If there are multiple code blocks, it opens a full-screen selector and includes a `Full answer` option.

## Install locally

This repo is intended to be symlinked into Pi's global extension directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /home/meri/git/pi-smart-copy ~/.pi/agent/extensions/pi-smart-copy
```

Then run `/reload` inside Pi.

## Development

```bash
bun install
bun test
bun run typecheck
```
