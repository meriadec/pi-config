# Store daemon-owned Work state in SQLite

Status: accepted

Human-authored Work configuration remains strict, versioned JSON, while daemon-owned durable state moves to a normalized SQLite database accessed through `@effect/sql-sqlite-bun`. Deep repository modules own SQL and transactions; the application does not receive a raw SQL client. Drizzle and other ORMs are not used because the database is small, fixed, and better served by visible SQL plus Effect Schema row decoding.

## Consequences

Topic families, Partitions, provisioning checkpoints, Main Agent identity, pull request identity, Durable Operations, idempotence results, confirmations, capability hashes, and inferred Integration Branches are transactionally stored. Observed Git, GitHub, Worktree, and live Agent state remains in memory. Schema migration requires a verified backup and fails closed. Existing JSON Topic data uses a one-time human-verified importer that is removed after cutover.
