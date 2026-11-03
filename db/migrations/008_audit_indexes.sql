-- ============================================================
-- 008: Audit Log Enhancements (DSGVO-compliant activity view)
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_api_key_ts ON mcp_audit_log (api_key_prefix, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_error ON mcp_audit_log (is_error) WHERE is_error = true;

-- Sanitized parameter summary (only parameter names, no values) for DSGVO compliance
ALTER TABLE mcp_audit_log ADD COLUMN IF NOT EXISTS param_summary VARCHAR(256) DEFAULT NULL;
