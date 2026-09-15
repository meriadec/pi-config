CREATE TABLE storage_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200),
  branch TEXT NOT NULL,
  repository TEXT NOT NULL,
  worktree_path TEXT,
  partition_number INTEGER NOT NULL,
  pull_request_number INTEGER CHECK (pull_request_number IS NULL OR pull_request_number > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (repository, branch)
);

CREATE TABLE topic_setup (
  topic_id TEXT PRIMARY KEY NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'ready', 'setup-failed', 'setup-interrupted')),
  repository_available INTEGER NOT NULL CHECK (repository_available IN (0, 1)),
  worktree_created INTEGER NOT NULL CHECK (worktree_created IN (0, 1)),
  setup_commands_run INTEGER NOT NULL CHECK (setup_commands_run IN (0, 1)),
  completed_command_count INTEGER NOT NULL CHECK (completed_command_count >= 0),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200)
);

CREATE TABLE topic_relationships (
  topic_id TEXT PRIMARY KEY NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  parent_topic_id TEXT REFERENCES topics(id) ON DELETE RESTRICT,
  origin_commit TEXT,
  integration_target_kind TEXT CHECK (integration_target_kind IN ('integration-branch', 'topic')),
  integration_target_topic_id TEXT REFERENCES topics(id) ON DELETE RESTRICT,
  chain_state TEXT CHECK (chain_state IN ('active', 'pending')),
  CHECK (parent_topic_id IS NULL OR parent_topic_id <> topic_id),
  CHECK (integration_target_topic_id IS NULL OR integration_target_topic_id <> topic_id),
  CHECK ((integration_target_kind = 'topic' AND integration_target_topic_id IS NOT NULL) OR
         (integration_target_kind = 'integration-branch' AND integration_target_topic_id IS NULL) OR
         (integration_target_kind IS NULL AND integration_target_topic_id IS NULL)),
  UNIQUE (parent_topic_id, origin_commit)
);

CREATE TABLE main_agent_identities (
  topic_id TEXT PRIMARY KEY NOT NULL REFERENCES topics(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  session_file TEXT
);

CREATE TABLE repository_state (
  repository TEXT PRIMARY KEY NOT NULL,
  inferred_integration_branch TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO storage_metadata (key, value, revision, updated_at)
VALUES ('schema-version', '1', 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
