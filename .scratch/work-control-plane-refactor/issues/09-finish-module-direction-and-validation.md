# 09 — Finish module direction and validation

Status: ready-for-agent
Type: refactor
Blocked by: 04, 05, 07, 08
Affected extension: `work`

## Context

After the external seam and major internal behavior are deepened, `shared/` still mixes domain types, atomic persistence, path policy, stores, and general helpers. Broad barrel exports make accidental dependency drift easy. The final issue must consolidate module ownership and prove that the refactor preserved behavior.

## Scope

- Organize remaining files by role: domain, control-plane contract, application implementation, persistence adapters, platform adapters, and presentation adapters.
- Replace broad `shared/index.ts`, `client/index.ts`, and `daemon/index.ts` exports with intentional interfaces or direct imports.
- Keep Topic, Branch, Start Point, Source checkout, Repository Recipe, Focus, and Main Agent vocabulary consistent with `CONTEXT.md` and `agent/extensions/work/CONTEXT.md`.
- Extend import-direction checks for the final module layout.
- Remove obsolete types, adapters, helpers, duplicate tests, and compatibility aliases introduced only during migration.
- Update `agent/extensions/work/README.md` architecture and storage sections to describe the final seams and adapter ownership.
- Add or update one architecture diagram that names modules, interfaces, seams, and adapters.
- Run all socket integration paths: dashboard, CLI, Pi tool, Topic Agent lifecycle, provisioning recovery, Action confirmation, and pull request refresh.
- Review test placement. Keep behavior at the deepest stable interface and retain direct adapter tests for protocol, persistence, process, TUI, and external-command behavior.

## Acceptance criteria

- [ ] Production dependency direction matches the epic diagram and is enforced by the harness.
- [ ] The control-plane contract has no implementation imports.
- [ ] Presentation adapters do not import daemon implementation files.
- [ ] Domain modules do not import persistence, transport, TUI, systemd, or external-command adapters.
- [ ] Broad barrels no longer expose internal implementation details.
- [ ] No obsolete shallow interface remains only to preserve old internal tests.
- [ ] Existing data files need no migration.
- [ ] README architecture text matches the implemented module layout and runtime ownership.
- [ ] All documented Work commands and tool examples still work in integration tests.
- [ ] `bun run check` passes.

## Validation

- Import-direction and export-surface checks.
- Full Work extension test suite and root harness.
- Manual review of persisted data compatibility and README examples.

## Comments
