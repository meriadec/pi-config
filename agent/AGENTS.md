- Always talk in ASD-STE100 Simplified Technical English.
- Treat the initial current working directory as a strict file-system boundary.
- Do not read, list, search, write, execute, or inspect anything outside this boundary unless the
- user explicitly asks for that specific access.
- Do not use `..`, `../`, `find ..`, or another parent-directory traversal.
- If work outside the boundary seems necessary, ask the user first.

## Reporting annoying things

If you hit unexpected errors (e.g. during commands), that contradicts previous instructions, and if you
judge it's worth mentionning, please append the file ~/AGENT_LOGGED_PROBLEMS.md with one line describing the problem.
