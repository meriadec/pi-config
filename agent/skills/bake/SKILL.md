---
name: bake
description: Bring a Minivault backend to a requested Revault manifest state.
disable-model-invocation: true
---

# Bake

Bring one Minivault workspace to the state requested by the user. Use `revault-cli` through the deterministic runner in this skill.

## Inputs

Extract these values before execution:

- **Minivault URL**: required. Treat it as the instance root; the runner accepts a trailing `/` or `/api`.
- **Workspace**: use the workspace stated by the user, or `minivault` when absent. It must match `^[a-z0-9]{1,20}$`.
- **Salt**: use the exact stated salt, or the empty string when absent.
- **Manifest**: resolve or generate it as described below.

Ask one focused question only when the URL is absent, a requested value has more than one safe interpretation, or execution is blocked. Do not ask for Minivault tokens or derived endpoint URLs.

## Resolve the manifest

If the user names a manifest path, use that exact file. For a bare name, check both locations, with and without `.json`:

- `~/manifests/`
- `~/ledger/revault/packages/cli/manifests/`

If both locations contain that name, show both paths and ask which one to use.

If the user describes data instead, run `mktemp -d` once and write `<workspace>-manifest.json` in the returned temporary directory:

1. Read all of `~/ledger/revault/packages/sdk/src/bake/types.ts` for the current schema.
2. Inspect only the closest examples in `~/ledger/revault/packages/cli/manifests/`.
3. Write a strict `manifestVersion: 2` manifest containing the requested state only.
4. Use operator device indexes from `10` upward. When an account has no stated index, start at `0` for that currency. When governance is not stated, use `CLASSIC`, quorum `1`, and all requested operators as members. Give every account a `SEND` rule. Give `canton` and `canton_devnet` accounts a `RECEIVE` rule too. Add other rules only when the user requests them.
5. Do not invent required domain values that have no clear type or repository precedent; ask for that value.

## Apply

Run exactly one invocation, passing the salt explicitly even when it is empty:

```bash
~/.pi/agent/skills/bake/scripts/apply.sh \
  --url '<minivault-root-url>' \
  --workspace '<workspace>' \
  --salt '<salt>' \
  --manifest '<absolute-manifest-path>'
```

The runner validates the manifest before remote mutation, derives `/api`, `/device-api`, and the Minivault tokens, inspects debug workspace/onboarding state, resumes or creates onboarding only when needed, verifies completion, and then runs the idempotent bake. It never wipes data.

On failure, preserve the command output, identify the failing stage, and report the blocker. Do not retry unchanged input. On success, report the instance, workspace, salt (state `empty` rather than omitting it), manifest path, whether onboarding ran or was skipped, and the successful bake result.
