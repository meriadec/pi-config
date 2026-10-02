- Always talk in ASD-STE100 Simplified Technical English.

- Treat the initial current working directory as a strict file-system boundary.
- Do not read, list, search, write, execute, or inspect anything outside this boundary unless the
- user explicitly asks for that specific access.
- Do not use `..`, `../`, `find ..`, or another parent-directory traversal.
- If work outside the boundary seems necessary, ask the user first.

- Each bash call starts in the initial current working directory. Do not prefix commands with `cd <cwd>`.
- Prefer relative path arguments over `cd <subdir> &&`. For package scripts, use tool flags such as `pnpm -C <dir>` or `--filter` when they work.

- No tautological tests

## Reporting annoying things

If you hit unexpected errors (e.g. during commands), that contradicts previous instructions, and if you
judge it's worth mentionning, please append the file ~/AGENT_LOGGED_PROBLEMS.md with one line describing the problem.
