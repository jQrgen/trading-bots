-- Every token the desk has seen, so new listings are noticed and researched.
CREATE TABLE tokens_seen (
  token_id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT,
  source TEXT NOT NULL,          -- 'cauldron' or 'launchpad'
  first_seen INTEGER NOT NULL,
  first_pool_ts INTEGER,
  last_tvl_bch REAL,
  research_status TEXT NOT NULL DEFAULT 'new',  -- new, researched, watch, avoid, traded
  last_research_at INTEGER
);

-- Launchpad (IDO) sales from the Cauldron indexer, as last seen.
CREATE TABLE launchpad (
  id TEXT PRIMARY KEY,
  offered_token_id TEXT,
  status TEXT,
  data TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- What the agents found when researching a token, and how they think it can make money.
CREATE TABLE research_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cycle INTEGER,
  agent TEXT NOT NULL,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  verdict TEXT NOT NULL,         -- opportunity, watch, avoid
  opportunity TEXT,              -- how it could make money (or why not)
  note TEXT NOT NULL,
  sources TEXT                   -- JSON array of links Grok used
);
CREATE INDEX research_notes_token ON research_notes (token_id, ts);

-- Sentiment on X for tokens, for Cauldron itself and for the BCH market, as judged by Grok.
CREATE TABLE sentiment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  cycle INTEGER,
  subject TEXT NOT NULL,         -- 'token', 'cauldron' or 'bch'
  token_id TEXT,
  symbol TEXT,
  score REAL NOT NULL,           -- -1 (very negative) to +1 (very positive)
  mentions INTEGER,              -- roughly how many relevant posts were seen
  summary TEXT NOT NULL,
  sources TEXT                   -- JSON array of post links
);
CREATE INDEX sentiment_subject ON sentiment (subject, token_id, ts);
