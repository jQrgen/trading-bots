-- Zara's per-trade reviews: process graded separately from outcome, one finding each (HyperGrok's review discipline).
CREATE TABLE IF NOT EXISTS trade_reviews (
  position_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  process TEXT NOT NULL,          -- clean | minor | major
  break_stage TEXT,               -- where the process broke, if it did
  outcome_pusd REAL,
  outcome_r REAL,                 -- result in multiples of the planned risk (cost x stop %)
  stop_overshoot_pct REAL,        -- how much further than the stop the exit filled, for stopped trades
  finding TEXT NOT NULL,
  agent TEXT NOT NULL DEFAULT 'zara'
);

-- Starter lessons from HyperGrok, scaled to Cauldron. The owner can reject any of them on the desk.
INSERT INTO lessons (ts, lesson) VALUES
  (strftime('%s','now') * 1000, '[HyperGrok] Size on what a stopped-out trade really costs: the stop plus overshoot, about 1.6% round-trip fees and exit impact. On Cauldron a 12% stop can easily lose 18%.'),
  (strftime('%s','now') * 1000, '[HyperGrok] Missing, stale or failed data is UNAVAILABLE, never "nothing happened". Say which read failed; do not trade on it.'),
  (strftime('%s','now') * 1000, '[HyperGrok] Grade process and outcome separately. A loss that followed the rules is fine; a win that broke them is a problem.'),
  (strftime('%s','now') * 1000, '[HyperGrok] Fewer than 30 closed trades is not evidence. Cauldron trades about $20k a day in total; a few wins prove nothing.'),
  (strftime('%s','now') * 1000, '[HyperGrok] Claims from X, Telegram or screenshots are ideas, not evidence. Check pool data and liquidity providers first; shills are common on small tokens.'),
  (strftime('%s','now') * 1000, '[HyperGrok] If an edge only survives at optimistic costs it is not an edge. Double fees and impact before believing a setup.');
