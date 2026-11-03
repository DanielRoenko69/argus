-- Alert rules own long-lived incident evidence. Archive them instead of
-- cascading a hard delete through the append-only remediation ledger.

ALTER TABLE mcp_observability_alert_rules
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by INTEGER REFERENCES mcp_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_observability_alert_rules_active
  ON mcp_observability_alert_rules (enabled, last_state, updated_at DESC)
  WHERE archived_at IS NULL;

COMMENT ON COLUMN mcp_observability_alert_rules.archived_at IS
  'Soft-deletion timestamp; historical incidents and append-only remediation evidence remain retained.';
