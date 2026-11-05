# Real env (and reads on any env)

`envs` lists the aliases with their stage, cluster and namespace. The table lives in `src/envs.ts`. PPR and PRD aliases point to `-argocd` namespaces, because the others are legacy. `sbx:<name>` is a disposable instance (namespace `minivault-<name>-sbx`).

## Recipes

- "What is X's version on E?": `version E X`. Answer with the tag. Say so when replicas are not all ready.
- "Pods of E": `pods E`. Flag `CrashLoopBackOff`, `Error`, `Pending` and high restart counts.
- "Last logs of A on E": `logs E A`. When a pod looks sick, start from `--grep 'error|fatal'`, then widen `--since`.
- "Is E up?": `pods E`, then `version E` for the tags.
- Cross-env comparison: run `version` on each env and put the tags side by side.
- Several workloads match `app` (the CLI lists up to 15): pick the one that fits the question, or ask.

## Reading the output

- `kubectl` is the only data source. ArgoCD sync status is out of reach. `version` shows the ArgoCD app name from the workload annotation.
- `version` reports the app container of each workload (the one named like the workload, else the first).
- `logs` merges all pods and containers of the workload by timestamp. Each line starts with `[pod/<name>/<container>]`. `--grep` matches that prefix and the timestamp too.
- An empty result prints `no log lines …`. A `[vault-env] kubectl:` line is a per-pod error from `kubectl`.
