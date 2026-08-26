# Epic — Agent-callable Topic creation

Status: ready-for-agent
Type: epic
Affected extension: `work`

## Problem

The work control plane can create a Topic only through the interactive `/work` dashboard. A Pi agent, shell user, or automation client cannot request the same operation through a typed interface. The current creation contract also accepts only a repository, Topic name, and Branch. It cannot create a new Branch from an exact commit in the invoking Git checkout.

A common case is a feature branch with several commits where one commit must become a separate Topic and pull request. The commit can be local and unpushed, and the daemon's Base checkout can be a different clone from the checkout in which the request starts.

## Outcome

- A Pi agent can create a Topic through the `work_topic_create` tool after a natural-language request.
- A shell user can create the same Topic through the `pi-work topic create` CLI.
- Both clients infer the GitHub repository from the Source checkout when the user omits it.
- Both clients derive an omitted Branch with the dashboard wizard's existing Topic-name normalization.
- An optional Git revision resolves to one exact Start Point commit before the daemon request.
- A local, unpushed Start Point can reach the Base checkout safely.
- Topic creation waits until provisioning is ready, fails, or needs direct user approval.

Example requests:

```text
Create a work Topic from HEAD~2 named "My contribution".
Create a work Topic for LedgerHQ/revault with Branch foo-bar.
```

Equivalent CLI calls:

```sh
pi-work topic create --name "My contribution" --start-point HEAD~2
pi-work topic create --name "My contribution" --repository LedgerHQ/revault --branch foo-bar
```

## Domain rules

- A Topic's durable identity remains its repository and Branch. A Start Point and Source checkout are creation inputs and do not enter the Topic manifest.
- The client sends an explicit `owner/repo` and exact Branch to the daemon. When the user supplies a Start Point, the client also sends its full commit SHA. Inference and user revision parsing stay at the client boundary.
- An omitted Start Point preserves current behavior: a missing Branch starts from the repository's default branch, and an existing Branch can be adopted.
- With a Start Point, a missing Branch is created at that exact commit. An existing Branch is adopted only when its tip equals the Start Point.
- No operation moves, resets, or force-updates an existing Branch.
- One repository and Branch pair can belong to only one Topic. A conflict identifies the existing Topic.
- A generated Branch conflict returns an error. The system does not add a numeric suffix.

## Architecture

The daemon remains the only owner of Topic manifests, provisioning, Action policies, deduplication, and concurrency. The Pi tool and CLI are thin clients over `WorkClient`. They share one resolver for repository inference, Branch generation, and Start Point resolution.

The Source checkout is an absolute, validated Git worktree path. When its Start Point is absent from the Base checkout, the daemon transfers the commit through Git after it proves that both checkouts have the requested GitHub origin. Commands use argument arrays, bounded output, timeouts, and cancellation.

The existing `topic.create-worktree` Action policy gates all Branch, commit-transfer, and Worktree mutations. `ask` always requires direct human approval. An agent cannot confirm for the user. A Pi UI or interactive terminal can collect approval; a non-interactive client returns a structured confirmation-required result.

## Client behavior

### Pi tool

Register `work_topic_create` with descriptions and examples that make natural-language Topic creation discoverable to the model. The tool uses `ctx.cwd` as the default Source checkout, emits bounded progress, and returns a structured final result. It does not open a Main Agent.

### CLI

Provide `pi-work topic create` with explicit flags and stable human and JSON output. The CLI uses its current directory as the default Source checkout, starts or connects to `pi-workd` through the existing systemd manager, and waits for provisioning. Interactive confirmation stays in the same client connection.

## Non-goals

- Do not open a Main Agent, terminal, workspace, or pull request after creation.
- Do not add a Topic-creation skill in this release.
- Do not select commits, rewrite a commit stack, push a Branch, or create a pull request.
- Do not add automatic Branch suffixes or reset conflicting Branches.
- Do not store Source checkout paths or Start Points in Topic manifests.
- Do not bypass `ask` or `deny` Action policies for agents or non-interactive clients.

## Validation

- Unit tests cover Branch normalization, repository inference, revision resolution, protocol parsing, policy handling, and conflict results.
- Provisioner tests use distinct temporary clones to prove transfer of a local, unpushed commit.
- Integration tests drive natural-language tool parameters and CLI arguments through the daemon to a ready Topic.
- Existing dashboard Topic creation remains compatible.
- Tool and CLI output stays bounded.
- `bun run check` passes.

## Issue order

1. `01-resolve-topic-creation-input.md`
2. `02-extend-the-daemon-creation-contract.md`
3. `03-provision-from-local-start-points.md`
4. `04-add-the-pi-work-create-cli.md`
5. `05-add-the-work-topic-create-tool.md`
6. `06-lock-in-integration-and-documentation.md`

Issue 01 is the shared client foundation. Issue 02 establishes the daemon contract and Branch uniqueness. Issue 03 completes Start Point provisioning. Issues 04 and 05 can then run in parallel. Issue 06 is the final integration issue.

## Comments
