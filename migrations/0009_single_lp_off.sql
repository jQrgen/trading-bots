-- Turn the stored single-LP limit off. Other risk rules stay as they are.
-- json_set drops a key when given SQL NULL, so json('null') writes a JSON null ("rule off").
UPDATE knowledge
SET body = json_set(body, '$.maxOwnerSharePct', json('null')),
    version = version + 1,
    updated_at = CAST(unixepoch() * 1000 AS INTEGER)
WHERE key = 'risk-limits'
  AND json_type(body, '$.maxOwnerSharePct') IN ('integer', 'real');

INSERT INTO knowledge_history (key, version, body, updated_by, updated_at)
SELECT k.key, k.version, k.body, 'seed', k.updated_at
FROM knowledge k
WHERE k.key = 'risk-limits'
  AND NOT EXISTS (SELECT 1 FROM knowledge_history h WHERE h.key = k.key AND h.version = k.version);
