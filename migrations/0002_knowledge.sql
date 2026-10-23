-- D1 is the source of truth for everything the team knows and does. The repo only holds code and
-- starter defaults (seed/), which are copied in once when a key doesn't exist yet.

-- Strategy, market notes, shared rules, agent roles, team graph, risk limits.
CREATE TABLE knowledge (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,       -- 'markdown' or 'json'
  body TEXT NOT NULL,
  version INTEGER NOT NULL,
  updated_by TEXT NOT NULL,   -- 'seed', 'owner' or an agent id
  updated_at INTEGER NOT NULL
);

-- Every version of every knowledge entry, so humans can see what changed and when.
CREATE TABLE knowledge_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX knowledge_history_key ON knowledge_history (key, version);

-- Every Grok call: the exact prompt and reply, for audit and debugging.
CREATE TABLE agent_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cycle INTEGER,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  search INTEGER NOT NULL,
  system_prompt TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  error TEXT,
  ms INTEGER NOT NULL
);
CREATE INDEX agent_calls_ts ON agent_calls (ts);

-- Every trade idea and what happened to it.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  agent TEXT NOT NULL,
  action TEXT NOT NULL,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon TEXT NOT NULL,
  size_pct REAL,
  target_pct REAL,
  stop_pct REAL,
  signal TEXT,
  thesis TEXT,
  bull_case TEXT,
  bear_case TEXT,
  status TEXT NOT NULL,       -- proposed, risk_failed, vetoed, rejected, approved, filled, skipped
  allowed_pusd REAL,
  risk_notes TEXT,
  decision_note TEXT,
  position_id INTEGER
);
CREATE INDEX proposals_ts ON proposals (ts);

-- Hourly copies of the 30-day scorecard the team uses to adjust itself.
CREATE TABLE scorecards (
  ts INTEGER PRIMARY KEY,
  window_days INTEGER NOT NULL,
  data TEXT NOT NULL
);
