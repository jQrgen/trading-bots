-- Live trading: on-chain transaction ids on trades, and snapshots tagged by mode so the live book
-- (and its 24h loss breaker) starts fresh instead of comparing against the paper book.
ALTER TABLE trades ADD COLUMN txid TEXT;
ALTER TABLE snapshots ADD COLUMN mode TEXT NOT NULL DEFAULT 'paper';
