# 06 — Lock in agent-callable Topic creation

Status: done
Type: feature
Blocked by: 04, 05
Affected extension: `work`

## Context

The final feature crosses Git input resolution, a versioned daemon protocol, durable Topic creation, local commit transfer, Action-policy confirmation, and two client surfaces. Unit tests at one seam cannot prove that all boundaries agree or that dashboard creation stayed compatible.

The work README still lists an LLM-callable control-plane tool as a version 1 limit.

## Scope

- Add an integration harness with temporary Source and Base checkouts, temporary work storage, fake process or desktop boundaries where appropriate, and a real WorkClient/daemon protocol connection.
- Drive this complete case through both client adapters:
  1. create a feature branch with three local, unpushed commits in the Source checkout;
  2. request a Topic from the first feature commit by a relative revision;
  3. infer repository and derive Branch from the Topic name;
  4. transfer the exact commit to a distinct Base checkout;
  5. create the Branch and Worktree;
  6. wait for a ready Topic;
  7. prove that no Main Agent or desktop action opened.
- Cover explicit repository and Branch creation without a Start Point.
- Cover direct human confirmation through both the CLI and Pi tool adapters without allowing model or headless approval.
- Add regression scenarios for duplicate Topics, an existing Branch at another commit, a mismatched Source checkout origin, local-only commit transfer failure, and client retry after a timed-out wait.
- Prove the Topic manifest contains no Start Point or Source checkout and daemon restart reconciliation stays ready.
- Update `agent/extensions/work/README.md` with tool and CLI usage, defaults, confirmation behavior, conflict rules, and bounded examples.
- Remove the version 1 statement that no LLM-callable control-plane tool exists. Keep unrelated version 1 limits unchanged.
- Document CLI installation or invocation so the literal `pi-work` command from the examples works in the supported local configuration.
- Keep `CONTEXT.md` terms aligned with the implemented language.

## Acceptance criteria

- [ ] The local three-commit scenario creates a ready Topic at the exact selected commit through the shared end-to-end path.
- [ ] Tool and CLI adapters produce equivalent resolved daemon input and final Topic details.
- [ ] A daemon restart validates and retains the resulting ready Topic.
- [ ] Existing dashboard creation without a Start Point still passes its integration tests.
- [ ] No tested conflict moves an existing Branch, creates a duplicate Topic, or adds a Branch suffix.
- [ ] `ask` has no agent-controlled or non-interactive approval route.
- [ ] Manifests, snapshots, logs, progress, and errors do not retain or leak unnecessary Source checkout data, credentials, or raw Setup output.
- [ ] README examples match tested CLI flags and Pi tool parameters.
- [ ] The documented `pi-work` command is executable in the supported setup.
- [ ] `bun run check` passes.

## Validation

- Cross-boundary creation integration suite.
- Existing daemon, provisioner, dashboard, systemd, and Topic Store suites.
- Manual smoke test after `/reload`: natural-language tool request, direct confirmation, and CLI request.
- Full harness.

## Comments
