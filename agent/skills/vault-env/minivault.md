# Disposable env (minivault on SBX)

vault-remote deploys **Instances** on SBX. The `enterprise-remote` MCP drives it. Call it from `codemode`: `await tools.mcp__enterprise_remote__<tool>({...})`. Results come back as `content[0].text` (JSON text).

MCP tools for this skill: `list_presets`, `list_instances`, `get_instance`, `deploy_instance`, `get_deployment`, `upgrade_instance`, `restart_pod`, `get_job`, `diagnose_instance`. Reads on pods and logs go through the CLI, data goes through Bake. Read a tool's declaration (`describeTool`) before the first call of a kind.

## Defaults (never ask)

- `owner`: `meri`
- `expiration`: `End of the day`
- `name`: the user's name if given. Else a meaningful one from the CLI `name` command (`repro-vg1234`): lowercase letters, digits and `-`, 20 chars max. Else omit it and vault-remote generates one.
- `versions`: only when the user names a branch or tag, or wants the versions of a Real env (see "Versions from a real env").

## Preset

Use the preset the user names. Else infer it from the request (a ticket about white labelling → `white-labelling`). Else ask once with the `list_presets` ids and recommend `main`.

## Plan

Show the plan before `deploy_instance` when the source is a ticket, or when you chose the preset, versions or data yourself. Skip it when the user stated all of them, or says to deploy right away.

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

1. Resolve name, preset, versions. Show the plan when it applies.
2. `deploy_instance`. Keep the deployment `id`.
3. Wait: loop `bash sleep 5`, then `get_deployment({ id })`, up to 120 times (10 minutes). `codemode` has no timers. Continue while `status` is `BUSY`. Start the next step only on `SUCCESS`.
4. Status `ERROR`, or still `BUSY` after 120 polls: call `diagnose_instance({ name })`. Report `error`, `currentStep` and the diagnosis. Redeploy only after the input changes.
5. `SUCCESS`: the URL is `https://<name>.minivault.ledger-sbx.com`. Report it with the expiration.
6. Data requested: Bake (below).
7. Reads on the new instance use env `sbx:<name>`.

## Change an instance

`upgrade_instance` (preset, versions, components, `extendExpiration`) and `restart_pod` return a job `id`.

1. Restart needs the pod name: read it from `get_instance({ name })` or `diagnose_instance({ name })` (for example `gate`).
2. Call the tool, then loop `bash sleep 5` and `get_job({ id })` while `status` is `RUNNING`, up to 120 times.
3. `SUCCESS`: report what changed. `ERROR`, or still `RUNNING` after 120 polls: `diagnose_instance` and report.

## Versions from a real env

Read the tags with `version <env>`, then map the image name to the `versions` key of `deploy_instance`:

| Image                                                                                                                            | Key                              |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `revault-api`, `revault-web`, `revault-backoffice`, `revault-notifier`, `vault-api-keys`, `leos-server`, `keycloak`, `tradelink` | same as the image                |
| `vault-notification-center`                                                                                                      | `notificationCenter`             |
| `les-wallet`                                                                                                                     | `lesWallet`                      |
| `ledger-vault-front`                                                                                                             | `front`                          |
| `ledger-vault-api`                                                                                                               | `gate`                           |
| `vault-api-gateway`                                                                                                              | `apiGateway`                     |
| `coin-gateway`                                                                                                                   | `coinGateway`                    |
| `vault-device-api` / `vault-device-registry`                                                                                     | `deviceAPI` / `deviceRegistry`   |
| `vault-organizations-api`                                                                                                        | `orgAPI`                         |
| `hsm-proxy` / `hsm-proxy-sequencer`                                                                                              | `hsmProxy` / `hsmProxySequencer` |

No row fits (or the key is typed `unknown` in the declaration): ask the user.

## Bake

Data goes in with the `bake` skill. Read `/home/mpillet/.pi/agent/skills/bake/SKILL.md` and follow it with the instance root URL from the spawn flow. It resolves or writes the manifest and runs `apply.sh`.

## Instances of the user

"What did I spawn?": `list_instances`, keep owner `meri`. Point out the ones past their `expireOn` and leave the decision to the user. The skill has no delete.

## Ticket repro

1. Read the ticket with the `jira` skill (summary, description, affected component, version, steps).
2. Choose preset, versions and data from the ticket. Note anything you guessed.
3. Show the plan and wait.
4. Run the spawn flow, then Bake if the ticket needs data.
5. Finish with the URL, the baked state, and the reproduction steps from the ticket.
