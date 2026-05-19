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
