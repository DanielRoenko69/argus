-- Migration 109 — real tamper-evident hash-chain on the immutable audit log.
-- Migration 058 already INTENDED a chain (row_hash = hash(prev_row_hash || key_fields))
-- but insertAuditRow never linked rows. This adds prev_hash (the link to the
-- previous row's row_hash). Going forward row_hash = sha256(prev_hash || canonical
-- row fields), computed app-side under a pg advisory lock (see immutableAudit.ts:
-- canonicalizeAuditFields / computeChainHash / insertAuditRow).
--
-- Legacy rows (pre-109) keep their NULL/weak row_hash; chain verification starts at
-- the first row with a non-NULL prev_hash (its prev_hash is the empty string '').
-- DDL (ALTER) is allowed by the append-only trigger (migration 095) — that trigger
-- only blocks row UPDATE/DELETE/TRUNCATE, not schema changes.
ALTER TABLE mcp_immutable_audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;

COMMENT ON COLUMN mcp_immutable_audit_log.prev_hash IS
  'Hash-chain link: row_hash of the previous (id-ordered) row. NULL for pre-migration-109 rows; empty string for the first chained row.';
