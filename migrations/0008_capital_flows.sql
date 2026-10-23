-- Live wallet capital flows: deposits and withdrawals the desk didn't make, so P&L is measured
-- against the capital the owner put in instead of counting a top-up as profit.
CREATE TABLE IF NOT EXISTS wallet_coins (
  outpoint TEXT PRIMARY KEY, -- txid:vout
  txid TEXT NOT NULL,
  sats INTEGER NOT NULL,
  asset TEXT,                -- token category, or NULL for plain BCH
  amount TEXT                -- token base units
);
CREATE TABLE IF NOT EXISTS capital_flows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- deposit | withdrawal
  outpoint TEXT NOT NULL,
  asset TEXT NOT NULL,       -- bch or token category
  amount TEXT NOT NULL,      -- sats or token base units
  pusd REAL NOT NULL         -- value when seen; negative for withdrawals
);
