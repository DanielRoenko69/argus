-- Governed actions use descriptive names (e.g. the 35-character
-- workflow_checkpoint_retry_requested). Never truncate those names or bypass
-- mandatory audit writes when continuing an existing workflow.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
ALTER TABLE mcp_admin_audit_log
  ALTER COLUMN action TYPE VARCHAR(128);
