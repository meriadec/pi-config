# 01 — Resolve Topic creation input

Status: done
Type: feature
Blocked by: none
Affected extension: `work`

## Context

The dashboard owns `defaultBranchForTopicName`, while new CLI and Pi tool clients need the same rule. They also need one testable boundary that turns optional user input and a working directory into the explicit Topic creation request accepted by the daemon.

A user can supply a revision such as `HEAD~2` or a short SHA. The daemon must receive a full commit SHA, not an ambiguous revision.

## Scope

- Move Topic-name-to-Branch normalization from `client/dashboard.ts` into a shared module and keep the dashboard behavior unchanged.
- Add a client-side Topic creation resolver with injectable Git process execution.
- Accept:
  - required Topic name;
  - optional `owner/repo`;
  - optional Branch;
  - optional user Start Point revision;
  - optional Source checkout, defaulted by each caller to its working directory.
- Return an explicit repository, validated Branch, and optional pair of full commit SHA plus absolute Source checkout.
- When repository is omitted, infer it from the Source checkout's GitHub `origin`.
- When repository is supplied and a Start Point is resolved, require the Source checkout origin to match it.
- Resolve a user Start Point to a commit with Git argument arrays and commit peeling. Reject missing objects, non-commit objects, and ambiguous revisions.
- Require the Source checkout to be a Git worktree root or normalize it to the containing worktree root. Return the canonical absolute path.
- Preserve explicit Branch spelling after trimming and validation. Derive an omitted Branch from the Topic name with the shared wizard rule.
- Keep process output, time, and error messages bounded.
- Do not connect to the daemon or mutate Git in this issue.

## Acceptance criteria

- [ ] Dashboard Branch suggestions are byte-for-byte compatible with the current helper, including Unicode normalization and ticket-prefix behavior.
- [ ] `My contribution` derives `my-contribution`, and ticket-style names retain the existing uppercase prefix behavior.
- [ ] An omitted repository is inferred from HTTPS and SSH GitHub origin forms.
- [ ] A supplied repository that differs from the Source checkout origin is rejected when resolving a Start Point.
- [ ] `HEAD~2`, short SHAs, and annotated tags resolve to one full commit SHA.
- [ ] A tree, blob, missing revision, or ambiguous revision is rejected with a bounded diagnostic.
- [ ] Explicit invalid Branches and Topic names that cannot produce a safe Branch are rejected.
- [ ] Resolver tests use an injected process seam and temporary Git repositories; they do not need GitHub or `workd`.
- [ ] `bun run check` passes.

## Validation

- Existing dashboard tests for `defaultBranchForTopicName`.
- Focused resolver tests for origin parsing, worktree-root discovery, revision peeling, and mismatch errors.
- Full harness.

## Comments
