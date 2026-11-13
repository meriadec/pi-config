# Env recipe: <NAME>

Copy to `.scratch/<NAME>/env.md` in the repo worktree. Steps use the capabilities of the `vault-env` skill. Keep it short.

## Needs

- Components: <image: PR / branch / tag>
- Preset: <preset>
- Flags: <flag: services>
- Data to bake: <manifest, workspace>

## Setup

1. <capability: values> → expected: <result>
2. …

## Verify

<command or page that proves the env is ready>

## Refresh

<what to run after a push>

## State

- Instance: <name> (owner <owner>)
- Expires: <date>
- Versions: <deployed tags>
- Last check: <date>
