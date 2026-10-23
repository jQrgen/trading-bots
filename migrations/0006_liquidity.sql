-- Paper liquidity positions: the desk runs its own constant-product micro-pool on Cauldron and earns the 0.3% pool fee.
CREATE TABLE IF NOT EXISTS lp_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  deposit_pusd REAL NOT NULL,       -- PUSD spent, including the swaps to fund both sides
  bch_sats REAL NOT NULL,           -- BCH side at deposit
  tokens REAL NOT NULL,             -- token side at deposit, whole tokens
  k REAL NOT NULL,                  -- bch_sats * tokens; the pool keeps this constant (fees accrue separately)
  entry_price_sats REAL NOT NULL,   -- sats per whole token at deposit
  stop_pct REAL NOT NULL,           -- withdraw if value incl. fees falls this far below the deposit
  fees_pusd REAL NOT NULL DEFAULT 0,  -- estimated fee income so far
  last_accrual_ts INTEGER NOT NULL,
  value_pusd REAL,                  -- latest mark: pool value + fees
  il_pct REAL,                      -- impermanent loss vs just holding the deposit's BCH and tokens
  signal TEXT,
  thesis TEXT,
  exit_pusd REAL,
  close_reason TEXT
);
CREATE INDEX IF NOT EXISTS lp_positions_status ON lp_positions (status);
