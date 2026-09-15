CREATE TABLE durable_operations (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  topic_id TEXT REFERENCES topics(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK (state IN ('accepted', 'awaiting-confirmation', 'running', 'setup-interrupted', 'succeeded', 'failed', 'cancelled')),
  phase TEXT NOT NULL CHECK (length(phase) BETWEEN 1 AND 100),
  input_version INTEGER NOT NULL CHECK (input_version = 1),
  input_json TEXT NOT NULL CHECK (length(input_json) <= 16384),
  result_version INTEGER CHECK (result_version IS NULL OR result_version = 1),
  result_json TEXT CHECK (result_json IS NULL OR length(result_json) <= 16384),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  UNIQUE (client_id, request_id),
  CHECK ((state IN ('succeeded', 'failed', 'cancelled') AND result_json IS NOT NULL AND terminal_at IS NOT NULL) OR
         (state NOT IN ('succeeded', 'failed', 'cancelled') AND result_json IS NULL AND terminal_at IS NULL))
);

CREATE TABLE operation_steps (
  operation_id TEXT NOT NULL REFERENCES durable_operations(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'interrupted')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  PRIMARY KEY (operation_id, step_index),
  CHECK ((state = 'running' AND completed_at IS NULL) OR
         (state IN ('completed', 'interrupted') AND completed_at IS NOT NULL))
);

CREATE TABLE atomic_command_results (
  client_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
  result_version INTEGER NOT NULL CHECK (result_version = 1),
  result_json TEXT NOT NULL CHECK (length(result_json) <= 16384),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (client_id, request_id)
);

CREATE TABLE confirmations (
  capability_hash TEXT PRIMARY KEY NOT NULL CHECK (length(capability_hash) = 64),
  operation_id TEXT REFERENCES durable_operations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE private_capabilities (
  capability_hash TEXT PRIMARY KEY NOT NULL CHECK (length(capability_hash) = 64),
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'affiliation')),
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  expires_at TEXT,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX durable_operations_terminal_retention
  ON durable_operations(terminal_at, id) WHERE terminal_at IS NOT NULL;
CREATE INDEX atomic_command_results_retention
  ON atomic_command_results(completed_at, client_id, request_id);
CREATE INDEX confirmations_expiry ON confirmations(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX private_capabilities_topic ON private_capabilities(topic_id, kind);

UPDATE storage_metadata SET value = '2', revision = revision + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE key = 'schema-version';
