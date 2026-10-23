-- The team's shared memory ("hivemind"): any notes, plans or files the bots want to keep between cycles.
CREATE TABLE IF NOT EXISTS bot_files (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'text/markdown',
  version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_files_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_files_history_path ON bot_files_history (path, version);
