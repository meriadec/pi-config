# Build GitHub and desktop adapters

Status: done

Depends on: 02, 07

Suggested commit: `refactor(work): add Effect desktop and GitHub adapters`

## Read first

- `../PRD.md`, especially Existing external tools and Main Agent behavior
- `daemon/pull-request-observer.ts`
- `daemon/desktop.ts`
- `client/systemd.ts` credential forwarding notes

## Objective

Move `gh`, i3, kitty, shell-launch, and browser behavior behind scoped Effect adapters with small semantic interfaces.

## Scope

1. Build the GitHub pull request observer with the existing lifecycle, CI, review, and terminal-identity rules.
2. Keep `gh` authentication behavior and bounded GraphQL output.
3. Build the desktop adapter for workspace access, terminal launch, Main Agent launch and close, and browser open.
4. Preserve exact i3 marks, workspace selection, kitty behavior, job control, shell startup files, and Main Agent environment semantics.
5. Use Effect FileSystem for private startup files and the process module for commands.
6. Decode i3 and GitHub payloads through Effect Schema.
7. Use typed operational failures and safe public results.
8. Keep focused behavior tests at the adapter interfaces and real process-contract tests where practical.
9. Delete old adapters when all callers move.

## Non-goals

- another desktop or terminal
- direct GitHub HTTP authentication
- replacing `gh`, `i3-msg`, kitty, or `xdg-open`

## Acceptance

- Existing desktop and pull request behavior is preserved.
- All subprocesses are scoped and bounded.
- Private launch files and environment values have safe permissions and redaction.
- External output is schema-decoded before use.
- `bun run check` passes.

## Comments
