# Prove operation and storage CLI commands

Status: done

## Parent

`../PRD.md`

## What to build

Complete the public contract for the Effect-added operation and storage CLI commands. Each command must have strict syntax, stable output, exact confirmation rules, bounded failures, and complete resource cleanup.

## Acceptance criteria

- [ ] Operation list and show emit stable human and versioned JSON output for active and terminal Durable Operations.
- [ ] Operation cancel requires explicit direct confirmation, consumes one-use authority, and distinguishes requested, completed, failed, expired, and rejected outcomes.
- [ ] Storage backup reports created versus not-needed results and never exposes private content.
- [ ] Storage verify accepts one exact absolute bundle path and reports checksum, SQLite, schema, and graph failure safely.
- [ ] Storage restore requires a stopped daemon, one exact backup path, and explicit confirmation; failed installation leaves current storage unchanged.
- [ ] Unknown, duplicate, missing, and incompatible options fail before constructing unnecessary resources.
- [ ] Human and JSON outputs use stable exit codes and keep diagnostics on stderr.
- [ ] Every runtime, maintenance scope, and signal handler is released on all outcomes.
- [ ] Public CLI tests cover syntax, output, confirmation, failure injection, cancellation, and cleanup for every command.
- [ ] The root harness passes.

## Blocked by

- `20-restore-topic-creation-cli.md`
