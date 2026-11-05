# Disposable env (minivault on SBX)

vault-remote deploys **Instances** on SBX. The `enterprise-remote` MCP drives it. Call it from `codemode`: `await tools.mcp__enterprise_remote__<tool>({...})`. Results come back as `content[0].text` (JSON text).

Tools: `list_presets`, `list_instances`, `get_instance`, `deploy_instance`, `get_deployment`, `diagnose_instance`, `upgrade_instance`, `restart_pod`. Read the tool's declaration (`describeTool`) before the first call of a kind. Do not use `get_pod_logs`, `*_workspace*`, or `bake_*`: reads go through the CLI, data through Bake.

## Defaults (never ask)

- `owner`: `meri`
- `expiration`: `End of the day`
- `name`: the user's name if given. Else derive a meaningful one with the CLI `name` command (`repro-vg1234`). It accepts lowercase letters, digits and `-` (no leading or trailing `-`), 20 chars max. Else omit it and vault-remote generates one.
- `versions`: only when the user names a branch or tag, or wants the versions of a Real env (read them with `version <env>`; keys are in the `deploy_instance` declaration).

## Preset

Use the preset the user names. Else infer it from the request (a ticket about white labelling → `white-labelling`). Else ask once with the `list_presets` ids and recommend `main`.

## Plan

Show a plan before `deploy_instance` when the request comes from a ticket, or when you inferred the preset, versions or data. Skip it when the user gives the preset themselves, says to deploy right away, or the request is clear and has no real doubt.

```
Plan
- Env:      Disposable (SBX)
- Name:     repro-vg1234        Owner: meri        Expires: End of the day
- Preset:   white-labelling     (why: …)
- Versions: default | revault-api=<tag> …
- Data:     bake → 4 ethereum accounts, 1 operator …
- Source:   <ticket url or sentence>
```

Wait for the user's answer before deploying.

## Spawn flow

1. Resolve name, preset, versions (above). Show the plan when it applies.
2. `deploy_instance` → keep the deployment `id`.
3. Wait for the deployment. `codemode` has no timers, so loop in two tools: `bash sleep 5`, then `get_deployment({ id })`. Repeat while `status` is `BUSY`. Never begin the next step before the status is `SUCCESS`.
4. Not `SUCCESS` (or no change after about 10 minutes): call `diagnose_instance`, report `error`, `currentStep` and the diagnosis. Do not redeploy the same input.
5. `SUCCESS`: the URL is `https://<name>.minivault.ledger-sbx.com`. Report it with the expiration.
6. Data requested: run Bake (below).
7. Reads on the new instance use env `sbx:<name>`.

## Bake

Data goes in with the `bake` skill. Read `/home/mpillet/.pi/agent/skills/bake/SKILL.md` and follow it with the instance URL (root URL from step 5). It resolves or writes the manifest and runs `apply.sh`. Do not restate its rules here.

## Instances of the user

"What did I spawn?": `list_instances`, keep owner `meri`. The skill never deletes instances. Point out the ones past their expiry and leave the decision to the user.

## Ticket repro

1. Read the ticket with the `jira` skill (summary, description, affected component, version, steps).
2. Choose preset, versions and data from the ticket. Note anything you guessed.
3. Show the plan (see above) and wait.
4. Run the spawn flow, then Bake if the ticket needs data.
5. Finish with the URL, the baked state, and the reproduction steps from the ticket.
