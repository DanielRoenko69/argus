-- Persisted tenant/workspace ownership for workflow definitions, executions
-- and both workflow approval trails. Existing single-workspace installations
-- remain in the historical default/default boundary.

ALTER TABLE mcp_workflows
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE mcp_workflow_executions
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE mcp_workflow_approvals
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

ALTER TABLE mcp_runtime_approvals
  ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  -- Migration 010 made workflow names globally unique. Names are now unique
  -- inside a workspace so two tenants can independently use the same slug.
  FOR constraint_name IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'mcp_workflows'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (name)'
  LOOP
    EXECUTE format('ALTER TABLE mcp_workflows DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_workflows_scope_name
  ON mcp_workflows (tenant_key, workspace_key, name);

-- Supports exact-scope foreign keys without changing the public/global id.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mcp_workflows_scope_id
  ON mcp_workflows (id, tenant_key, workspace_key);

CREATE INDEX IF NOT EXISTS idx_mcp_workflows_scope_enabled
  ON mcp_workflows (tenant_key, workspace_key, enabled, name);

CREATE INDEX IF NOT EXISTS idx_mcp_wf_exec_scope_workflow
  ON mcp_workflow_executions (tenant_key, workspace_key, workflow_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_workflow_approvals_scope
  ON mcp_workflow_approvals (tenant_key, workspace_key, workflow_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_mcp_runtime_approvals_scope_status
  ON mcp_runtime_approvals (tenant_key, workspace_key, status, requested_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_workflows_tenant_key_chk') THEN
    ALTER TABLE mcp_workflows ADD CONSTRAINT mcp_workflows_tenant_key_chk
      CHECK (tenant_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_workflows_workspace_key_chk') THEN
    ALTER TABLE mcp_workflows ADD CONSTRAINT mcp_workflows_workspace_key_chk
      CHECK (workspace_key ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_wf_exec_scope_fk') THEN
    ALTER TABLE mcp_workflow_executions ADD CONSTRAINT mcp_wf_exec_scope_fk
      FOREIGN KEY (workflow_id, tenant_key, workspace_key)
      REFERENCES mcp_workflows (id, tenant_key, workspace_key) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'mcp_workflow_approvals_scope_fk') THEN
    ALTER TABLE mcp_workflow_approvals ADD CONSTRAINT mcp_workflow_approvals_scope_fk
      FOREIGN KEY (workflow_id, tenant_key, workspace_key)
      REFERENCES mcp_workflows (id, tenant_key, workspace_key) ON DELETE CASCADE;
  END IF;
END $$;

COMMENT ON COLUMN mcp_workflows.tenant_key IS
  'Server-authorized tenant owner; browser values are selectors only.';
COMMENT ON COLUMN mcp_workflows.workspace_key IS
  'Server-authorized workspace owner; legacy rows remain default/default.';
COMMENT ON COLUMN mcp_workflow_executions.tenant_key IS
  'Immutable tenant owner copied from the workflow at execution creation.';
COMMENT ON COLUMN mcp_workflow_executions.workspace_key IS
  'Immutable workspace owner copied from the workflow at execution creation.';
