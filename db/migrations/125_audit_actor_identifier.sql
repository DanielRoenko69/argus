-- Audit events are now emitted by users, workflows, and internal services in
-- addition to 8-character API key prefixes. Preserve those readable actors
-- instead of truncating them or dropping the audit event.

ALTER TABLE mcp_audit_log
  ALTER COLUMN api_key_prefix TYPE TEXT;
