-- Follow-up integrity constraints for runtime approvals. Kept separate from
-- migration 251 because 251 may already be recorded by pilot installations.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_runtime_approvals_tenant_key_chk'
  ) THEN
    ALTER TABLE mcp_runtime_approvals
      ADD CONSTRAINT mcp_runtime_approvals_tenant_key_chk
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_runtime_approvals_workspace_key_chk'
  ) THEN
    ALTER TABLE mcp_runtime_approvals
      ADD CONSTRAINT mcp_runtime_approvals_workspace_key_chk
      CHECK (workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
END $$;

COMMENT ON COLUMN mcp_runtime_approvals.tenant_key IS
  'Immutable tenant owner copied from the initiating execution.';
COMMENT ON COLUMN mcp_runtime_approvals.workspace_key IS
  'Immutable workspace owner copied from the initiating execution.';
