CREATE TABLE IF NOT EXISTS latest_snapshots (
  machine_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  os TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  collected_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  agent_count INTEGER NOT NULL,
  gateway_state TEXT,
  snapshot_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshot_events_machine_received
  ON snapshot_events(machine_id, received_at DESC);

CREATE TABLE IF NOT EXISTS layout_overrides (
  agent_id   TEXT PRIMARY KEY,
  x          REAL NOT NULL,
  y          REAL NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_daily (
  agent_id        TEXT    NOT NULL,
  day             TEXT    NOT NULL,
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL    NOT NULL DEFAULT 0,
  trace_count     INTEGER NOT NULL DEFAULT 0,
  model_breakdown TEXT,
  fetched_at      TEXT    NOT NULL,
  PRIMARY KEY (agent_id, day)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_agent_day
  ON usage_daily(agent_id, day DESC);
