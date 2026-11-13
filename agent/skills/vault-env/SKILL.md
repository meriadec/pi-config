---
name: vault-env
description: "Operate Ledger Vault envs: spawn disposable minivaults, bake data, read pods, logs and versions on STG/PPR/PRD."
disable-model-invocation: true
---

# vault-env

Operate Vault **envs** for the user. Terms are in [GLOSSARY.md](GLOSSARY.md).

## Route the request

Start at the first row that fits. A request can chain rows ("spawn, then bake, then read logs"): run them in order.

| The user wants…                                                                                            | Env        | Start at                                         |
| ---------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------ |
| An env to test some work (ticket, PR, topic)                                                               | Disposable | [Recipes](#recipes)                              |
| An env from a ticket URL                                                                                   | Disposable | [minivault.md](minivault.md) → "Ticket repro"    |
| A new env, or to change one (upgrade, restart, extend expiry)                                              | Disposable | [minivault.md](minivault.md)                     |
| Data in a workspace (accounts, operators, whitelists, rules)                                               | Disposable | [minivault.md](minivault.md) → "Bake"            |
| Pods, logs or versions on `vault-next`, `vault-main`, `vault-load`, `vault-ppr`, `vault-ppr2`, `vault-prd` | Real       | [real-env.md](real-env.md)                       |
| Pods, logs or versions of a disposable instance                                                            | Disposable | [real-env.md](real-env.md) with env `sbx:<name>` |

If the env is unclear (a bare "ppr", "stg", or no env), ask which alias.

## Recipes

A **recipe** is the env plan of one piece of work (ticket, PR or topic): which **capabilities** to run, in which order, with which values. Capabilities are the operations in [minivault.md](minivault.md) and the CLI below. Component-specific facts (image builds, tags, flags, pods) live in the skills of the repo you work in, not here. A recipe is specific to that work and lives with the work, never in `~/.pi`: `.scratch/<NAME>/env.md` in the repo worktree, or in the ticket or PR text. Write a new one from [recipe-template.md](recipe-template.md).

Run a recipe:

1. Read it. If State names an instance, check it with `get_instance` (expiry, status). A live instance: go to Refresh or Verify.
2. Run each Setup step with its capability. Check the expected result before the next step.
3. Run Verify. Done only when it passes.
4. Write State back: instance name, expiry, versions deployed, date of the check.

## Rules

- **Read = CLI, change = MCP.** Reads (pods, logs, versions) use the CLI below. Changes to a disposable instance use the `enterprise-remote` MCP, called from `codemode` as `tools.mcp__enterprise_remote__<tool>`.
- **Real envs are read-only.** For a request to change one (restart, scale, deploy), answer with the route: a PR in `~/ledger/sre-argocd`, or the user acts by hand.
- **Owner is `meri`.** Every `deploy_instance` call uses `owner: meri`.
- **Data goes in with the `bake` skill** (`~/.pi/agent/skills/bake/SKILL.md`). Use it for any accounts, operators, whitelists or rules, also inside a recipe Setup step.
- A run is done when the user's question has an answer, or the blocker is named with its exact error.

## CLI

`bun ~/.pi/agent/skills/vault-env/scripts/vault-env.ts <command>`. Run it without arguments for the command list and flags. `<env>` is an alias (`envs` lists them) or `sbx:<instance-name>`.

- Output is capped. A `[vault-env] truncated …` line means lines were dropped: narrow with `--grep` and `--since` before widening `--tail`.
- A Teleport login error prints the `tsh` commands. Give them to the user to run.
- Real-env log lines can hold customer data. Quote only short lines, and only when the answer needs them.
