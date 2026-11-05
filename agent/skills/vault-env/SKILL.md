---
name: vault-env
description: Operate Ledger Vault envs: spawn disposable minivaults, bake data, read pods, logs and versions on STG/PPR/PRD.
disable-model-invocation: true
---

# vault-env

Operate Vault **envs** for the user. Terms are in [GLOSSARY.md](GLOSSARY.md).

## Route the request

Pick the **env** first. Say it back to the user in one line when the request leaves room for doubt.

| The user wants…                                                                                            | Env            | Read                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| A new env to test or reproduce on, data on it, or a change to an instance (upgrade, restart)               | Disposable env | [minivault.md](minivault.md)                                             |
| Pods, logs or versions on `vault-next`, `vault-main`, `vault-load`, `vault-ppr`, `vault-ppr2`, `vault-prd` | Real env       | [real-env.md](real-env.md)                                               |
| Pods, logs or versions of an existing disposable instance                                                  | Disposable env | [real-env.md](real-env.md), env `sbx:<name>`                             |
| Data in a workspace (accounts, operators, whitelists, rules)                                               | either         | Bake, via [minivault.md](minivault.md)                                   |
| An env from a ticket URL                                                                                   | Disposable env | Read the ticket with the `jira` skill, then [minivault.md](minivault.md) |

A request can chain branches ("spawn, then bake, then read logs"). Run them in order.

## Rules

- **Read = CLI, change = MCP.** Every read (pods, logs, versions) uses `scripts/vault-env.ts`. Every change to a disposable instance uses the `enterprise-remote` MCP, called from `codemode` as `tools.mcp__enterprise_remote__<tool>`.
- Real envs are read-only. A request to change one (restart, scale, deploy) gets a refusal and the right route: a PR in `~/ledger/sre-argocd`, or the user acts by hand.
- Report what you ran and what came back. A run is done when the user's question has an answer, or the blocker is named with its exact error.

## CLI

Run `bun ~/.pi/agent/skills/vault-env/scripts/vault-env.ts <command>`. Run it without arguments for usage.

| Command                                               | Answers                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `envs [--verify]`                                     | Aliases, clusters, namespaces. `--verify` checks them against `tsh kube ls`.                                                |
| `pods <env> [--grep RE]`                              | Pod state.                                                                                                                  |
| `logs <env> <app> [--tail N] [--since D] [--grep RE]` | Logs. Capped: default `--tail 200 --since 15m`, max `--tail 2000`. A `[vault-env] truncated` line means lines were dropped. |
| `version <env> [app]`                                 | Live image tag, ready replicas and ArgoCD app per workload. `app` matches a workload name or an image name (`les-wallet`).  |
| `name <text>`                                         | A valid instance name from free text.                                                                                       |

`<env>` is an alias or `sbx:<instance-name>`. On a Teleport login error the CLI prints the `tsh` commands. Give them to the user. Never run a login.

Narrow logs with `--grep` and `--since` before widening `--tail`. Quote real-env log lines in the answer only when short and needed. They can hold customer data.
