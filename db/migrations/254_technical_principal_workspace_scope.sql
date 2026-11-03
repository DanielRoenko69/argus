-- Bind non-browser credentials and short-lived execution identities to one
-- explicit tenant/workspace boundary. Existing records belong to the legacy
-- single-workspace installation and are therefore backfilled as
-- default/default; callers cannot reinterpret that compatibility scope.

ALTER TABLE mcp_api_keys
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE argus_execution_grants
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE mcp_hermes_dev_connections
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE mcp_hermes_dev_bridge_tasks
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_api_keys_workspace_scope_check'
  ) THEN
    ALTER TABLE mcp_api_keys ADD CONSTRAINT mcp_api_keys_workspace_scope_check
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
         AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'argus_execution_grants_workspace_scope_check'
  ) THEN
    ALTER TABLE argus_execution_grants ADD CONSTRAINT argus_execution_grants_workspace_scope_check
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
         AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_hermes_dev_connections_workspace_scope_check'
  ) THEN
    ALTER TABLE mcp_hermes_dev_connections ADD CONSTRAINT mcp_hermes_dev_connections_workspace_scope_check
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
         AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mcp_hermes_dev_bridge_tasks_workspace_scope_check'
  ) THEN
    ALTER TABLE mcp_hermes_dev_bridge_tasks ADD CONSTRAINT mcp_hermes_dev_bridge_tasks_workspace_scope_check
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
         AND workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_workspace_scope
  ON mcp_api_keys (tenant_key, workspace_key, enabled);

CREATE INDEX IF NOT EXISTS idx_argus_execution_grants_workspace_scope
  ON argus_execution_grants (tenant_key, workspace_key, issued_at DESC);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_connections_workspace_scope
  ON mcp_hermes_dev_connections (tenant_key, workspace_key, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_hermes_dev_bridge_tasks_workspace_scope
  ON mcp_hermes_dev_bridge_tasks (tenant_key, workspace_key, created_at DESC);

COMMENT ON COLUMN mcp_api_keys.tenant_key IS
  'Server-owned tenant boundary for this technical credential.';
COMMENT ON COLUMN mcp_api_keys.workspace_key IS
  'Server-owned workspace boundary for this technical credential.';
COMMENT ON COLUMN argus_execution_grants.tenant_key IS
  'Tenant copied into the signed grant and immutable trace evidence at issuance.';
COMMENT ON COLUMN argus_execution_grants.workspace_key IS
  'Workspace copied into the signed grant and immutable trace evidence at issuance.';
