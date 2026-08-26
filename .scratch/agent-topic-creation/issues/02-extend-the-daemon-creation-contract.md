# 02 — Extend the daemon Topic creation contract

Status: done
Type: feature
Blocked by: 01
Affected extension: `work`

## Context

`topic.create` currently accepts only `NewTopic`, and Topic Service permits two manifests for the same repository and Branch. Agent and CLI clients need a versioned contract that carries an optional exact Start Point and Source checkout without changing the durable Topic manifest.

Creation can arrive concurrently under different request IDs. Branch uniqueness must therefore be enforced at the service boundary, not only by a client-side snapshot check.

## Scope

- Define a creation request type separate from durable `NewTopic` data. It contains explicit Topic fields plus an optional Start Point record with:
  - one full commit SHA;
  - one absolute Source checkout path.
- Extend `WorkClient`, protocol parsing, server dispatch, Topic Service, and provisioner request wiring with this input.
- Bump the work protocol version and update protocol fixtures.
- Validate all new fields again at the daemon trust boundary. Reject unknown fields, malformed SHAs, relative paths, and oversized values.
- Keep Start Point and Source checkout out of `TopicManifest`, Topic Store files, snapshots, and events.
- Enforce one Topic per repository and Branch before a manifest is created.
- Serialize the uniqueness check and manifest creation by repository and Branch so concurrent requests cannot create duplicates.
- Return a `topic-branch-conflict` protocol error with bounded `existingTopicId` and `existingTopicName` details. Extend `WorkFailure` and `WorkClientError` with optional typed details instead of encoding identity only in the message.
- Preserve request deduplication: retrying the same client and request ID returns the same operation, while different arguments still produce `request-id-conflict`.
- Preserve old dashboard creation by allowing requests without a Start Point.
- Pass the validated Start Point to the provisioner. Until issue 03 implements Start Point provisioning, reject such a request with `start-point-unsupported`; never silently create it from the default branch.

## Acceptance criteria

- [ ] The protocol accepts only a full commit SHA paired with an absolute Source checkout.
- [ ] A Topic manifest written from the extended request has no Start Point or Source checkout field.
- [ ] Existing dashboard requests without a Start Point still reach `ready` under the current rules.
- [ ] A second request for the same repository and Branch returns the first Topic ID and name and writes no manifest.
- [ ] Two concurrent requests for the same repository and Branch produce exactly one Topic manifest.
- [ ] The same Branch name remains valid in a different repository.
- [ ] Protocol tests cover malformed, unknown, oversized, and backward-compatible inputs.
- [ ] Before issue 03 lands, a valid Start Point request fails explicitly and cannot create a Branch from the wrong commit.
- [ ] WorkClient and daemon tests use the new protocol version consistently.
- [ ] `bun run check` passes.

## Validation

- Protocol parser and encoder tests.
- Topic Service deduplication and concurrent uniqueness tests.
- Topic Store assertion that creation-only fields are absent.
- Existing dashboard-to-daemon creation tests.
- Full harness.

## Comments
