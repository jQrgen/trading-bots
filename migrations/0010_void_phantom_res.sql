-- Phantom live fill: position 3 bought RES for 24.88 PUSD, but the broadcast never reached the chain.
-- Void it at cost (0 P&L) so the book matches the wallet: 247.67 PUSD and no RES.

UPDATE holdings
SET amount = 24767
WHERE asset = 'pusd'
  AND EXISTS (
    SELECT 1 FROM positions
    WHERE id = 3 AND symbol = 'RES' AND amount = 19453130 AND ROUND(cost_pusd, 2) = 24.88
  );

INSERT INTO holdings (asset, symbol, amount)
SELECT 'pusd', 'PUSD', 24767
WHERE NOT EXISTS (SELECT 1 FROM holdings WHERE asset = 'pusd')
  AND EXISTS (
    SELECT 1 FROM positions
    WHERE id = 3 AND symbol = 'RES' AND amount = 19453130 AND ROUND(cost_pusd, 2) = 24.88
  );

DELETE FROM holdings
WHERE EXISTS (
  SELECT 1 FROM positions
  WHERE id = 3 AND symbol = 'RES' AND amount = 19453130 AND ROUND(cost_pusd, 2) = 24.88
)
AND (
  symbol = 'RES'
  OR asset IN (SELECT token_id FROM positions WHERE id = 3 AND symbol = 'RES' AND amount = 19453130)
);

UPDATE trades
SET pusd = 0,
    reason = TRIM(COALESCE(reason, '') || ' [voided: phantom, broadcast never accepted]')
WHERE txid = '09f7b5bee1a33b3cfa5806a1528f50ab64db69bb9d209e6f7e44577b19fcb408'
  AND side = 'buy'
  AND position_id = 3;

UPDATE positions
SET status = 'closed',
    closed_at = COALESCE(closed_at, CAST(unixepoch() * 1000 AS INTEGER)),
    exit_pusd = cost_pusd,
    close_reason = 'voided: phantom fill, broadcast never accepted'
WHERE id = 3
  AND symbol = 'RES'
  AND amount = 19453130
  AND ROUND(cost_pusd, 2) = 24.88;

INSERT INTO events (ts, agent, kind, message)
SELECT CAST(unixepoch() * 1000 AS INTEGER), 'desk', 'correction',
  'Voided phantom position 3 RES: broadcast never reached the chain. Closed at cost, 0 P&L. Book matches the wallet (247.67 PUSD, no RES).'
WHERE EXISTS (
  SELECT 1 FROM positions
  WHERE id = 3 AND symbol = 'RES' AND amount = 19453130 AND ROUND(cost_pusd, 2) = 24.88 AND exit_pusd = cost_pusd
);
