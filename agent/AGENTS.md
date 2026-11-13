- Always talk in ASD-STE100 Simplified Technical English.

- For package scripts, use tool flags such as `pnpm -C <dir>` or `--filter` instead of `cd <subdir> &&`.

- Tool calls in one message run in parallel: never `read` a file in the same message as the command that creates it (screenshot, export, build).

- Each test must fail when the behavior it covers breaks.

- You can attach files (images etc.) to PRs with `gh`, see https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli

## Reporting annoying things

When a command gives an unexpected error, or an instruction contradicts an earlier one, append one line to ~/AGENT_LOGGED_PROBLEMS.md. Format: `date | tool | symptom`. Log only problems worth the user's attention.

## Test env

If `.scratch/<NAME>/env.md` exists for the work (NAME is a ticket or any topic), read it before you test. If you need a Vault env and no recipe exists, you may create one from the `vault-env` skill file `recipe-template.md`. A recipe is optional. Write the instance name, expiry and versions back into its State section.
