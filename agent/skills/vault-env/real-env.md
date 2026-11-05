# Real env (and reads on any env)

| Alias        | Stage | Cluster                         | Namespace                |
| ------------ | ----- | ------------------------------- | ------------------------ |
| `vault-next` | STG   | shared-application-2021-cluster | `2043-vault-next`        |
| `vault-main` | STG   | shared-application-2021-cluster | `2063-vault-main`        |
| `vault-load` | STG   | shared-application-2021-cluster | `2087-vault-load`        |
| `vault-ppr`  | PPR   | shared-application-2094-cluster | `2060-vault-ppr-argocd`  |
| `vault-ppr2` | PPR   | shared-application-2094-cluster | `2090-vault-ppr2-argocd` |
| `vault-prd`  | PRD   | shared-application-2026-cluster | `2108-vault-prd-argocd`  |
| `sbx:<name>` | SBX   | sandbox-2042-cluster            | `minivault-<name>-sbx`   |

The table lives in `src/envs.ts`. Namespaces without the `-argocd` suffix are legacy: never use them. When the user says "ppr" or "stg" without an alias, ask which alias.

## Recipes

- "What is X's version on E?": `version E X`. Answer with the tag, and say when replicas are not all ready.
- "Pods of E": `pods E`. Flag `CrashLoopBackOff`, `Error`, `Pending` and high restart counts.
- "Last logs of A on E": `logs E A`. Without a time window, use the default. When a pod looks sick, start from `--grep 'error|fatal'`, then widen `--since`.
- "Is E up?": `pods E`, then `version E` for the tags.
- Many workloads match `app`: the CLI lists them. Pick the one that fits the question, or ask.
- Cross-env comparison: run `version` on each env and put the tags side by side.

## Limits

- `kubectl` is the only data source. ArgoCD sync status is not reachable from here. `version` shows the ArgoCD app name from the workload annotation.
- Log lines are interleaved across pods by timestamp. Each line carries a `[pod/<name>/<container>]` prefix.
