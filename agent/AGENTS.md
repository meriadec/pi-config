- Always talk in ASD-STE100 Simplified Technical English.

- Work only inside the initial current working directory. Ask the user before you access any other path.

- For package scripts, use tool flags such as `pnpm -C <dir>` or `--filter` instead of `cd <subdir> &&`.

- Each test must fail when the behavior it covers breaks.

## Reporting annoying things

When a command gives an unexpected error, or an instruction contradicts an earlier one, append one line to ~/AGENT_LOGGED_PROBLEMS.md. Format: `date | tool | symptom`. Log only problems worth the user's attention.
