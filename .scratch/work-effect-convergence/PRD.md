# Work Effect product convergence

## Problem

The Effect migration retained much of the Work control plane backend, but it did not preserve the complete product contract. The migration specification required current dashboard keys, layout behavior, actions, status meanings, tools, CLI commands, policy semantics, Topic creation, child creation, Partitions, Notes, Main Agent control, pull request observation, Integration Status, chain maintenance, guarded rebase, Worktree recovery, Repository Recipes, and Topic Agent environment meanings.

The post-migration audit found 96 behavior rows: 19 Present, 39 Partial, 16 Missing, 19 Broken, 1 intentional removal, and 2 Added. Only 19 of 93 retained previous behaviors are confirmed at their product boundary.

## Sources of truth

- The detailed inventory and current status are in `../work-effect-v4/CONVERGENCE-AUDIT.md`.
- The previous production contract is commit `33500e4`, especially the Work README and public behavior tests.
- The Effect migration requirements are in `../work-effect-v4/PRD.md`.
- Legacy name hierarchy behavior remains intentionally removed.

## Objective

Make the Effect implementation converge on the complete non-Legacy Work product contract without restoring the old storage, protocol, resource lifecycle, or Promise-owned runtime implementation.

## User outcomes

1. A human can use every previous `/work` key, wizard, action, focus transition, list behavior, status, and confirmation flow.
2. Sensitive Actions follow configured `allow`, `ask`, and `deny` policy at every production entry point.
3. A Topic Agent survives daemon lease loss and restart without false failure messages or delayed re-attachment.
4. Root and child Topic creation, Setup retry and cancellation, Integration Chain maintenance, and Integration Branch reset are complete dashboard paths.
5. Pull request, Integration Status, Git operation, Worktree, operation, diagnostic, and Main Agent state retain their useful detail through projection and rendering.
6. Both Pi tools and all documented CLI commands preserve their public parsing, confirmation, cancellation, timeout, output, and cleanup contracts.
7. A final live checkpoint confirms convergence against the previous implementation.

## Constraints

- Keep the Effect architecture, scoped resource ownership, SQLite storage, Durable Operations, Atomic Commands, and revisioned snapshot stream.
- Do not reintroduce the old private protocol, JSON Topic storage, manual timer ownership, or Legacy name hierarchy behavior.
- Each implementation issue is a vertical slice with public seam tests and a demoable user outcome.
- Port relevant previous tests by behavior. Do not copy tests that assert deleted implementation details.
- Expected failures stay typed and bounded. Private capabilities never enter logs, snapshots, Topic names, Notes, or test output.
- Action policy must fail closed when configuration is invalid or unavailable.
- The root harness must pass after each issue.

## Delivery plan

The issues under `issues/` are in dependency order. Early tracer slices establish reusable policy, input, and projection seams while delivering complete user-visible behavior. Later slices restore composition, external adapters, and final live verification.

## Completion

This epic is complete only when:

- every retained row in the convergence audit is Present,
- both Added dashboard requirements are Present,
- all relevant previous public behavior has an equivalent Effect-path test,
- no sensitive Action bypasses policy,
- the root harness passes,
- daemon restart and live Main Agent re-attachment pass,
- the final human verification records approval.
