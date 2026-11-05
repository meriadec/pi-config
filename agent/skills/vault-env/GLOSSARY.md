# vault-env

Where an agent runs, reproduces or inspects Ledger Vault.

## Language

**Env**:
Any Vault deployment the skill can target: a Disposable env or a Real env.

**Disposable env**:
A minivault **Instance** that vault-remote deploys on the SBX cluster. It has an owner and an expiration.
_Avoid_: sandbox env, temp env

**Real env**:
An ArgoCD-managed prod-like deployment on STG, PPR or PRD. Read-only for this skill.
_Avoid_: prod env (PRD is only one of them)

**Instance**:
One Disposable env, named `<name>`, in namespace `minivault-<name>-sbx`.

**Alias**:
The short name of an env: `vault-next`, `vault-prd`, or `sbx:<instance-name>`.

**Preset**, **Workspace**:
As in `~/ledger/vault-remote/GLOSSARY.md`.

**Bake**:
Bring a workspace to a requested state with the `bake` skill. Never with the MCP.
