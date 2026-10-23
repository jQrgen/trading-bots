-- Append-only log of everything the desk does. Shown on the website.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cycle INTEGER,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX events_ts ON events (ts);

-- Paper wallet balances in base units. asset is 'pusd', 'bch' or a token category.
CREATE TABLE holdings (
  asset TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  amount INTEGER NOT NULL
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  horizon TEXT NOT NULL,
  amount INTEGER NOT NULL,
  cost_pusd REAL NOT NULL,
  entry_price_pusd REAL NOT NULL,
  target_pct REAL NOT NULL,
  stop_pct REAL NOT NULL,
  signal TEXT,
  thesis TEXT,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  exit_pusd REAL,
  close_reason TEXT,
  status TEXT NOT NULL DEFAULT 'open'
);

CREATE TABLE snapshots (
  ts INTEGER PRIMARY KEY,
  total_pusd REAL NOT NULL,
  bch_pusd REAL NOT NULL
);

CREATE TABLE agent_status (
  agent TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  lessons TEXT NOT NULL
);

-- Every fill, paper or live. The permanent trade record.
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cycle INTEGER,
  mode TEXT NOT NULL,
  side TEXT NOT NULL,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  amount INTEGER NOT NULL,
  pusd REAL NOT NULL,
  price_pusd REAL NOT NULL,
  impact_pct REAL NOT NULL,
  estimated INTEGER NOT NULL,
  position_id INTEGER,
  reason TEXT
);
CREATE INDEX trades_ts ON trades (ts);

-- Lessons from Zara's journal. Active lessons feed the agents; the owner can set status to 'rejected'.
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  lesson TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

-- Market data per cycle for the top tokens, kept for backtesting and research.
CREATE TABLE market_ticks (
  ts INTEGER NOT NULL,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price_pusd REAL,
  tvl_bch REAL,
  chg_24h_pct REAL,
  volume_sats INTEGER,
  PRIMARY KEY (ts, token_id)
);
