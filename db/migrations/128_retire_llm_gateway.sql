-- Retire legacy LLM-gateway naming while preserving platform settings,
-- immutable operational data and the direct-provider model catalog.

DO $$
BEGIN
  IF to_regclass('public.mcp_gateway_settings') IS NOT NULL
     AND to_regclass('public.mcp_platform_settings') IS NULL THEN
    ALTER TABLE mcp_gateway_settings RENAME TO mcp_platform_settings;
  END IF;

  IF to_regclass('public.mcp_gateway_admin_audit_log') IS NOT NULL
     AND to_regclass('public.mcp_admin_audit_log') IS NULL THEN
    ALTER TABLE mcp_gateway_admin_audit_log RENAME TO mcp_admin_audit_log;
  END IF;
END $$;

ALTER INDEX IF EXISTS idx_gw_audit_log_time RENAME TO idx_admin_audit_log_time;
ALTER INDEX IF EXISTS idx_gw_audit_log_table RENAME TO idx_admin_audit_log_table;
ALTER INDEX IF EXISTS idx_gw_audit_log_action RENAME TO idx_admin_audit_log_action;
ALTER INDEX IF EXISTS idx_gw_audit_log_actor RENAME TO idx_admin_audit_log_actor;

ALTER TABLE mcp_users DROP CONSTRAINT IF EXISTS mcp_users_role_check;
UPDATE mcp_users SET role = 'operations_admin' WHERE role = 'gateway_admin';
ALTER TABLE mcp_users ADD CONSTRAINT mcp_users_role_check
  CHECK (role IN ('platform_admin','operations_admin','developer','agent_operator','viewer','chat_user'));

ALTER TABLE mcp_agents DROP CONSTRAINT IF EXISTS mcp_agents_min_role_check;
UPDATE mcp_agents SET min_role = 'operations_admin' WHERE min_role = 'gateway_admin';
ALTER TABLE mcp_agents ADD CONSTRAINT mcp_agents_min_role_check
  CHECK (min_role IS NULL OR min_role IN
    ('platform_admin','operations_admin','developer','agent_operator','viewer','chat_user'));

ALTER TABLE mcp_api_keys
  DROP COLUMN IF EXISTS gateway_enabled,
  DROP COLUMN IF EXISTS gateway_admin;

COMMENT ON TABLE mcp_platform_settings IS
  'Runtime-overridable Argus platform configuration.';
COMMENT ON TABLE mcp_admin_audit_log IS
  'Audit trail for privileged Argus administration changes.';
